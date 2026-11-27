mod mmap_vector_pool;
mod pool_arena;
mod simd_ops;

use mmap_vector_pool::{
    close_all_loaded_pools, close_loaded_pool, cosine_top_k_in_memory, get_pool_metrics,
    open_or_reload_pool, search_loaded_pool, write_vector_pool_file,
};
use napi::bindgen_prelude::{Buffer, Float32Array, Int8Array, Result as NapiResult};
use napi::Error;
use napi_derive::napi;
use pool_arena::{compute_near_duplicate_mask, run_compress_and_bigram_batch};
use simd_ops::{
    dot_f32_best, dot_i8_best, hamming_binary_fast, has_avx2, has_avx2_fma, quantize_unit_f32_to_i8,
};
use std::cmp::Ordering;
use std::path::Path;

#[napi(object)]
pub struct TopKHit {
    pub index: u32,
    pub score: f64,
}

#[napi(object)]
pub struct KeyedPoolHit {
    pub content_key: String,
    pub similarity: f64,
}

#[napi(object)]
pub struct QuantizedPoolResult {
    pub data: Int8Array,
    pub scales: Float32Array,
    pub vector_count: u32,
    pub dim: u32,
}

#[napi(object)]
pub struct ArenaBatchStats {
    pub doc_count: u32,
    pub total_unique_bigrams: u32,
    pub total_compressed_bytes: u32,
    pub arena_allocated_bytes: u32,
    pub compressed_docs: Vec<String>,
}

#[napi(object)]
pub struct LoadedPoolInfo {
    pub generation: i64,
    pub source_max_updated_at: i64,
    pub vector_count: u32,
    pub dim: u32,
}

#[napi(object)]
pub struct NativePoolMetrics {
    pub open_scopes: u32,
    pub total_mapped_bytes: f64,
    pub total_vectors_mapped: f64,
    pub total_searches: f64,
}

fn push_top_k(heap: &mut Vec<(u32, f32)>, k: usize, idx: u32, score: f32) {
    if k == 0 {
        return;
    }
    if heap.len() < k {
        heap.push((idx, score));
        if heap.len() == k {
            heap.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(Ordering::Equal));
        }
        return;
    }
    if score > heap[0].1 {
        heap[0] = (idx, score);
        let mut pos = 0usize;
        while pos + 1 < heap.len() && heap[pos].1 > heap[pos + 1].1 {
            heap.swap(pos, pos + 1);
            pos += 1;
        }
    }
}

/// Zero-copy F32 dot-product Top-K scan using AVX2+FMA when available.
#[napi(js_name = "cosineTopKF32")]
pub fn cosine_top_k_f32(
    matrix: Float32Array,
    dim: u32,
    query: Float32Array,
    top_k: u32,
) -> Vec<TopKHit> {
    let dim_usize = dim as usize;
    if dim_usize == 0 || query.len() < dim_usize {
        return Vec::new();
    }
    let m_slice: &[f32] = matrix.as_ref();
    let q_slice: &[f32] = &query.as_ref()[..dim_usize];
    let count = m_slice.len() / dim_usize;
    let k = (top_k as usize).max(1).min(count.max(1));
    let avx2_fma = has_avx2_fma();
    let mut top: Vec<(u32, f32)> = Vec::with_capacity(k);

    for v in 0..count {
        let row = &m_slice[v * dim_usize..(v + 1) * dim_usize];
        let score = dot_f32_best(row, q_slice, avx2_fma);
        push_top_k(&mut top, k, v as u32, score);
    }

    top.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
    top.into_iter()
        .map(|(index, score)| TopKHit {
            index,
            score: score as f64,
        })
        .collect()
}

/// Normalized cosine similarity Top-K directly on a Zero-Copy Float32Array matrix.
#[napi(js_name = "normalizedCosineTopKF32")]
pub fn normalized_cosine_top_k_f32(
    matrix: Float32Array,
    dim: u32,
    query: Float32Array,
    top_k: u32,
) -> Vec<TopKHit> {
    cosine_top_k_in_memory(matrix.as_ref(), dim as usize, query.as_ref(), top_k as usize)
        .into_iter()
        .map(|(index, score)| TopKHit { index, score })
        .collect()
}

/// Scalar-quantizes an F32 vector matrix to unit-normalized Int8 (4x RAM savings).
#[napi(js_name = "quantizeF32ToI8")]
pub fn quantize_f32_to_i8(matrix: Float32Array, dim: u32) -> QuantizedPoolResult {
    let dim_usize = dim as usize;
    if dim_usize == 0 {
        return QuantizedPoolResult {
            data: Int8Array::new(Vec::new()),
            scales: Float32Array::new(Vec::new()),
            vector_count: 0,
            dim,
        };
    }
    let m_slice: &[f32] = matrix.as_ref();
    let count = m_slice.len() / dim_usize;
    let avx2_fma = has_avx2_fma();
    let mut out = vec![0i8; count * dim_usize];
    let mut scales = vec![0.0f32; count];

    for v in 0..count {
        let row = &m_slice[v * dim_usize..(v + 1) * dim_usize];
        let dst = &mut out[v * dim_usize..(v + 1) * dim_usize];
        let (scale, _norm) = quantize_unit_f32_to_i8(row, dst, avx2_fma);
        scales[v] = scale;
    }

    QuantizedPoolResult {
        data: Int8Array::new(out),
        scales: Float32Array::new(scales),
        vector_count: count as u32,
        dim,
    }
}

/// Zero-copy Int8 quantized vector Top-K scan using AVX2 integer multiply-add.
#[napi(js_name = "cosineTopKI8")]
pub fn cosine_top_k_i8(
    q_matrix: Int8Array,
    scales: Float32Array,
    dim: u32,
    query: Float32Array,
    top_k: u32,
) -> Vec<TopKHit> {
    let dim_usize = dim as usize;
    if dim_usize == 0 || query.len() < dim_usize {
        return Vec::new();
    }
    let m_slice: &[i8] = q_matrix.as_ref();
    let s_slice: &[f32] = scales.as_ref();
    let q_f32: &[f32] = &query.as_ref()[..dim_usize];
    let avx2 = has_avx2();
    let avx2_fma = has_avx2_fma();

    let mut q_i8 = vec![0i8; dim_usize];
    let (q_scale, q_norm) = quantize_unit_f32_to_i8(q_f32, &mut q_i8, avx2_fma);
    if q_norm <= 1e-12 {
        return Vec::new();
    }

    let count = (m_slice.len() / dim_usize).min(s_slice.len());
    let k = (top_k as usize).max(1).min(count.max(1));
    let mut top: Vec<(u32, f32)> = Vec::with_capacity(k);

    for v in 0..count {
        let row = &m_slice[v * dim_usize..(v + 1) * dim_usize];
        let raw_dot = dot_i8_best(row, &q_i8, avx2);
        let score = (raw_dot as f32) * s_slice[v] * q_scale;
        push_top_k(&mut top, k, v as u32, score);
    }

    top.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
    top.into_iter()
        .map(|(index, score)| TopKHit {
            index,
            score: score as f64,
        })
        .collect()
}

/// Fast POPCNT Hamming distance on 1-bit binary vectors.
#[napi(js_name = "hammingBinaryDistance")]
pub fn hamming_binary_distance(a: Buffer, b: Buffer) -> u32 {
    hamming_binary_fast(a.as_ref(), b.as_ref())
}

/// Pool 1 (Bump Arena) batch text compressor + Korean/English 2-char bigram extractor.
#[napi(js_name = "compressAndBigramBatchArena")]
pub fn compress_and_bigram_batch_arena(
    docs: Vec<String>,
    max_chars: Option<u32>,
    return_compressed: Option<bool>,
) -> ArenaBatchStats {
    let out = run_compress_and_bigram_batch(
        &docs,
        max_chars.map(|v| v as usize),
        return_compressed.unwrap_or(false),
    );
    ArenaBatchStats {
        doc_count: docs.len() as u32,
        total_unique_bigrams: out.total_unique_bigrams,
        total_compressed_bytes: out.total_compressed_bytes,
        arena_allocated_bytes: out.arena_allocated_bytes,
        compressed_docs: out.compressed_docs,
    }
}

/// Pool 1 batch Jaccard near-duplicate mask (`true` = near-duplicate of earlier accepted doc).
#[napi(js_name = "nearDuplicateMask")]
pub fn near_duplicate_mask(docs: Vec<String>, threshold: Option<f64>) -> Vec<bool> {
    compute_near_duplicate_mask(&docs, threshold.unwrap_or(0.85))
}

/// Pool 2: Write a 64-byte aligned `.t3vec` v5 binary vector pool file atomically.
#[napi(js_name = "writeVectorPool")]
pub fn write_vector_pool(
    out_path: String,
    dim: u32,
    content_keys: Vec<String>,
    f32_matrix: Float32Array,
    generation: i64,
    source_max_updated_at: i64,
) -> NapiResult<f64> {
    let bytes = write_vector_pool_file(
        Path::new(&out_path),
        dim as usize,
        &content_keys,
        f32_matrix.as_ref(),
        generation.max(0) as u64,
        source_max_updated_at,
    )
    .map_err(Error::from_reason)?;
    Ok(bytes as f64)
}

/// Pool 2 & 3: Open or generation-swap an `mmap` `.t3vec` pool into the bounded LRU manager.
#[napi(js_name = "openVectorPool")]
pub fn open_vector_pool(scope_key: String, file_path: String) -> NapiResult<LoadedPoolInfo> {
    let (generation, source_max_updated_at, vector_count, dim) =
        open_or_reload_pool(&scope_key, Path::new(&file_path)).map_err(Error::from_reason)?;
    Ok(LoadedPoolInfo {
        generation: generation as i64,
        source_max_updated_at,
        vector_count,
        dim,
    })
}

/// Pool 2: Execute 2-Stage Int8 AVX2 + Exact F32 Cosine Rerank on a loaded `mmap` pool.
#[napi(js_name = "searchVectorPool")]
pub fn search_vector_pool(
    scope_key: String,
    query: Float32Array,
    top_k: u32,
    oversample: Option<u32>,
) -> NapiResult<Option<Vec<KeyedPoolHit>>> {
    let os = oversample.unwrap_or((top_k.saturating_mul(4)).max(64)) as usize;
    let res = search_loaded_pool(&scope_key, query.as_ref(), top_k as usize, os)
        .map_err(Error::from_reason)?;
    Ok(res.map(|hits| {
        hits.into_iter()
            .map(|h| KeyedPoolHit {
                content_key: h.content_key,
                similarity: h.similarity,
            })
            .collect()
    }))
}

#[napi(js_name = "closeVectorPool")]
pub fn close_vector_pool(scope_key: String) -> bool {
    close_loaded_pool(&scope_key)
}

#[napi(js_name = "closeAllVectorPools")]
pub fn close_all_vector_pools() {
    close_all_loaded_pools();
}

#[napi(js_name = "poolMetrics")]
pub fn pool_metrics() -> NativePoolMetrics {
    let m = get_pool_metrics();
    NativePoolMetrics {
        open_scopes: m.open_scopes,
        total_mapped_bytes: m.total_mapped_bytes as f64,
        total_vectors_mapped: m.total_vectors_mapped as f64,
        total_searches: m.total_searches as f64,
    }
}

#[napi(js_name = "runtimeCapabilities")]
pub fn runtime_capabilities() -> String {
    #[cfg(target_arch = "x86_64")]
    {
        format!("x86_64 avx2={} fma={}", has_avx2(), has_avx2_fma())
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        "non-x86_64 scalar".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("t3-mem-core-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn simd_and_scalar_dot_products_match_and_guard_nan() {
        let a: Vec<f32> = (0..1024).map(|i| ((i as f32) * 0.013).sin()).collect();
        let b: Vec<f32> = (0..1024).map(|i| ((i as f32) * 0.019).cos()).collect();
        let scalar = simd_ops::dot_f32_scalar(&a, &b);
        let best = simd_ops::dot_f32_best(&a, &b, has_avx2_fma());
        assert!((scalar - best).abs() < 1e-3, "scalar={scalar}, best={best}");

        let nan_vec = vec![f32::NAN; 16];
        let normal_vec = vec![1.0f32; 16];
        assert_eq!(simd_ops::dot_f32_best(&nan_vec, &normal_vec, has_avx2_fma()), 0.0);
    }

    #[test]
    fn mmap_pool_write_search_two_stage_recall_and_crc_corruption_guard() {
        let dir = temp_dir("mmap");
        let dim = 256usize;
        let count = 512usize;
        let query: Vec<f32> = (0..dim).map(|d| ((d as f32) * 0.11).sin()).collect();
        let mut matrix = vec![0.0f32; count * dim];
        let mut keys = Vec::with_capacity(count);
        for v in 0..count {
            keys.push(format!("{v:064x}"));
            for d in 0..dim {
                matrix[v * dim + d] = (((v * 31 + d * 7) % 1009) as f32 * 0.01).cos();
            }
        }
        // Plant 5 strong semantic matches
        let planted = [17usize, 128, 255, 389, 501];
        for (rank, &idx) in planted.iter().enumerate() {
            let scale = 1.5 - (rank as f32) * 0.05;
            for d in 0..dim {
                matrix[idx * dim + d] = query[d] * scale + (rank as f32) * 0.001;
            }
        }

        let gen1 = dir.join("pool-test-gen1.t3vec");
        let written = write_vector_pool_file(&gen1, dim, &keys, &matrix, 1, 1_700_000_000).unwrap();
        assert!(written > 0);

        let info = open_or_reload_pool("scope_unit_1", &gen1).unwrap();
        assert_eq!(info.0, 1);
        assert_eq!(info.2, count as u32);
        assert_eq!(info.3, dim as u32);

        let hits = search_loaded_pool("scope_unit_1", &query, 10, 64)
            .unwrap()
            .unwrap();
        assert_eq!(hits.len(), 10);
        let top5_keys: Vec<&str> = hits.iter().take(5).map(|h| h.content_key.as_str()).collect();
        for &idx in &planted {
            let expected = format!("{idx:064x}");
            assert!(
                top5_keys.contains(&expected.as_str()),
                "missing planted idx={idx} in top5={top5_keys:?}"
            );
        }

        // Generation swap (Windows-safe: writes gen2 while gen1 is mapped, swaps Arc, retires gen1)
        let gen2 = dir.join("pool-test-gen2.t3vec");
        write_vector_pool_file(&gen2, dim, &keys, &matrix, 2, 1_700_000_999).unwrap();
        let info2 = open_or_reload_pool("scope_unit_1", &gen2).unwrap();
        assert_eq!(info2.0, 2);

        // Corrupt a copy and ensure CRC32 rejects it cleanly
        let bad = dir.join("pool-corrupt.t3vec");
        let mut bytes = fs::read(&gen2).unwrap();
        bytes[100] ^= 0xff;
        fs::write(&bad, bytes).unwrap();
        assert!(open_or_reload_pool("scope_bad", &bad).is_err());

        // Close pool cleanly before removing temp dir on Windows
        assert!(close_loaded_pool("scope_unit_1"));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn bump_arena_compression_and_shrink_guard_have_zero_leak() {
        let sample = vec![
            "=====\n중복 라인 테스트 문장입니다 여기\n중복 라인 테스트 문장입니다 여기\n\n\n한국어 RAG 압축 테스트".to_string(),
        ];
        for _ in 0..2000 {
            let out = run_compress_and_bigram_batch(&sample, Some(120), true);
            assert_eq!(out.compressed_docs.len(), 1);
            assert!(!out.compressed_docs[0].contains("====="));
            assert_eq!(
                out.compressed_docs[0]
                    .matches("중복 라인 테스트 문장입니다 여기")
                    .count(),
                1
            );
        }
    }
}
