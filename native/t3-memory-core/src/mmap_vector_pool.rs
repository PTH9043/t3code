//! Pool 2 & Pool 3: Read-Only `mmap` Quantized Vector Pool (`*.t3vec` v5) with
//! Windows-safe Generation Versioning, CRC32 integrity verification, Two-Stage
//! Int8 AVX2 + Exact F32 Reranking, and Bounded LRU Pool Management (<= 8 scopes / 64 MiB).

use crate::simd_ops::{
    cosine_f32_best, dot_i8_best, has_avx2, has_avx2_fma, l2_norm_f32, quantize_unit_f32_to_i8,
};
use memmap2::Mmap;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, RwLock};
use std::time::Instant;

const MAGIC: &[u8; 8] = b"T3VEC005";
const FORMAT_VERSION: u32 = 5;
const HEADER_SIZE: usize = 64;
const KEY_SLOT_BYTES: usize = 64; // 64-byte hex SHA-256 content_key
const FLAG_HAS_I8: u32 = 1 << 0;
const FLAG_HAS_F32: u32 = 1 << 1;

const MAX_RESIDENT_SCOPES: usize = 8;
const MAX_RESIDENT_BYTES: usize = 64 * 1024 * 1024;
const IDLE_EVICT_SECS: u64 = 15 * 60;

#[inline]
fn align64(offset: usize) -> usize {
    (offset + 63) & !63
}

pub struct VectorPoolHit {
    pub content_key: String,
    pub similarity: f64,
}

pub struct PoolManagerMetrics {
    pub open_scopes: u32,
    pub total_mapped_bytes: u64,
    pub total_vectors_mapped: u64,
    pub total_searches: u64,
}

struct MmapVectorPool {
    file_path: PathBuf,
    mmap: Mmap,
    dim: usize,
    count: usize,
    generation: u64,
    source_max_updated_at: i64,
    keys_offset: usize,
    scales_offset: usize,
    norms_offset: usize,
    i8_offset: usize,
    f32_offset: usize,
    mapped_bytes: usize,
}

impl MmapVectorPool {
    fn open(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("open failed: {e}"))?;
        let mmap = unsafe { Mmap::map(&file) }.map_err(|e| format!("mmap failed: {e}"))?;
        let len = mmap.len();
        if len < HEADER_SIZE + 4 {
            return Err("t3vec file too small".to_string());
        }
        if &mmap[0..8] != MAGIC {
            return Err("invalid t3vec magic".to_string());
        }
        let version = u32::from_le_bytes(mmap[8..12].try_into().unwrap());
        if version != FORMAT_VERSION {
            return Err(format!("unsupported t3vec version: {version}"));
        }
        let dim = u32::from_le_bytes(mmap[12..16].try_into().unwrap()) as usize;
        let count = u32::from_le_bytes(mmap[16..20].try_into().unwrap()) as usize;
        let flags = u32::from_le_bytes(mmap[20..24].try_into().unwrap());
        let generation = u64::from_le_bytes(mmap[24..32].try_into().unwrap());
        let source_max_updated_at = i64::from_le_bytes(mmap[32..40].try_into().unwrap());
        let stored_header_crc = u32::from_le_bytes(mmap[40..44].try_into().unwrap());
        let calc_header_crc = crc32fast::hash(&mmap[0..40]);
        if stored_header_crc != calc_header_crc {
            return Err("t3vec header crc32 mismatch".to_string());
        }
        if dim == 0 || (flags & FLAG_HAS_I8) == 0 || (flags & FLAG_HAS_F32) == 0 {
            return Err("t3vec missing required i8/f32 sections".to_string());
        }

        let keys_offset = HEADER_SIZE;
        let keys_bytes = count
            .checked_mul(KEY_SLOT_BYTES)
            .ok_or_else(|| "keys_bytes overflow".to_string())?;
        let scales_offset = align64(keys_offset + keys_bytes);
        let scales_bytes = count
            .checked_mul(4)
            .ok_or_else(|| "scales_bytes overflow".to_string())?;
        let norms_offset = align64(scales_offset + scales_bytes);
        let norms_bytes = count
            .checked_mul(4)
            .ok_or_else(|| "norms_bytes overflow".to_string())?;
        let i8_offset = align64(norms_offset + norms_bytes);
        let i8_bytes = count
            .checked_mul(dim)
            .ok_or_else(|| "i8_bytes overflow".to_string())?;
        let f32_offset = align64(i8_offset + i8_bytes);
        let f32_bytes = count
            .checked_mul(dim)
            .and_then(|v| v.checked_mul(4))
            .ok_or_else(|| "f32_bytes overflow".to_string())?;
        let footer_offset = f32_offset + f32_bytes;
        if footer_offset + 4 != len {
            return Err(format!(
                "t3vec truncated: expected {} bytes, got {}",
                footer_offset + 4,
                len
            ));
        }

        let stored_footer_crc = u32::from_le_bytes(mmap[footer_offset..len].try_into().unwrap());
        let calc_footer_crc = crc32fast::hash(&mmap[0..footer_offset]);
        if stored_footer_crc != calc_footer_crc {
            return Err("t3vec footer crc32 mismatch".to_string());
        }

        Ok(Self {
            file_path: path.to_path_buf(),
            mmap,
            dim,
            count,
            generation,
            source_max_updated_at,
            keys_offset,
            scales_offset,
            norms_offset,
            i8_offset,
            f32_offset,
            mapped_bytes: len,
        })
    }

    #[inline]
    fn key_at(&self, index: usize) -> &str {
        let start = self.keys_offset + index * KEY_SLOT_BYTES;
        let raw = &self.mmap[start..start + KEY_SLOT_BYTES];
        let trimmed_len = raw.iter().position(|&b| b == 0).unwrap_or(KEY_SLOT_BYTES);
        std::str::from_utf8(&raw[..trimmed_len]).unwrap_or("")
    }

    #[inline]
    fn scales(&self) -> &[f32] {
        let ptr = unsafe { self.mmap.as_ptr().add(self.scales_offset) as *const f32 };
        unsafe { std::slice::from_raw_parts(ptr, self.count) }
    }

    #[inline]
    fn norms(&self) -> &[f32] {
        let ptr = unsafe { self.mmap.as_ptr().add(self.norms_offset) as *const f32 };
        unsafe { std::slice::from_raw_parts(ptr, self.count) }
    }

    #[inline]
    fn i8_row(&self, index: usize) -> &[i8] {
        let start = self.i8_offset + index * self.dim;
        let ptr = unsafe { self.mmap.as_ptr().add(start) as *const i8 };
        unsafe { std::slice::from_raw_parts(ptr, self.dim) }
    }

    #[inline]
    fn f32_row(&self, index: usize) -> &[f32] {
        let start = self.f32_offset + index * self.dim * 4;
        let ptr = unsafe { self.mmap.as_ptr().add(start) as *const f32 };
        unsafe { std::slice::from_raw_parts(ptr, self.dim) }
    }

    fn search_two_stage(
        &self,
        query: &[f32],
        top_k: usize,
        oversample: usize,
    ) -> Result<Vec<VectorPoolHit>, String> {
        if self.count == 0 {
            return Ok(Vec::new());
        }
        if query.len() < self.dim {
            return Err(format!(
                "query dim mismatch: expected {}, got {}",
                self.dim,
                query.len()
            ));
        }
        let q_slice = &query[..self.dim];
        let avx2 = has_avx2();
        let avx2_fma = has_avx2_fma();

        let mut q_i8 = vec![0i8; self.dim];
        let (q_scale, q_norm) = quantize_unit_f32_to_i8(q_slice, &mut q_i8, avx2_fma);
        if q_norm <= 1e-12 {
            return Ok(Vec::new());
        }

        let stage1_k = oversample.max(top_k).min(self.count).max(1);
        let scales = self.scales();
        let mut stage1: Vec<(usize, f32)> = Vec::with_capacity(stage1_k);

        // Stage 1: Full AVX2 Int8 scan (~4 ms for 38k x 1024d)
        for idx in 0..self.count {
            let dot = dot_i8_best(self.i8_row(idx), &q_i8, avx2);
            let approx = (dot as f32) * scales[idx] * q_scale;
            push_top_k_usize(&mut stage1, stage1_k, idx, approx);
        }

        // Stage 2: Exact F32 AVX2+FMA cosine rerank on top-stage1_k candidates (~0.02 ms)
        let norms = self.norms();
        let mut reranked: Vec<(usize, f32)> = Vec::with_capacity(stage1.len());
        for &(idx, _) in &stage1 {
            let sim = cosine_f32_best(self.f32_row(idx), q_slice, norms[idx], q_norm, avx2_fma);
            reranked.push((idx, sim));
        }
        reranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal).then_with(|| a.0.cmp(&b.0)));
        reranked.truncate(top_k.max(1));

        Ok(reranked
            .into_iter()
            .map(|(idx, sim)| VectorPoolHit {
                content_key: self.key_at(idx).to_owned(),
                similarity: sim as f64,
            })
            .collect())
    }
}

fn push_top_k_usize(heap: &mut Vec<(usize, f32)>, k: usize, idx: usize, score: f32) {
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

/// Atomically writes a 64-byte aligned `.t3vec` v5 binary pool file with header & footer CRC32.
pub fn write_vector_pool_file(
    out_path: &Path,
    dim: usize,
    content_keys: &[String],
    f32_matrix: &[f32],
    generation: u64,
    source_max_updated_at: i64,
) -> Result<usize, String> {
    if dim == 0 {
        return Err("dim must be > 0".to_string());
    }
    let count = content_keys.len();
    if f32_matrix.len() != count * dim {
        return Err(format!(
            "matrix length mismatch: expected {}, got {}",
            count * dim,
            f32_matrix.len()
        ));
    }
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }

    let avx2_fma = has_avx2_fma();
    let mut scales = vec![0.0f32; count];
    let mut norms = vec![0.0f32; count];
    let mut i8_matrix = vec![0i8; count * dim];

    for v in 0..count {
        let row = &f32_matrix[v * dim..(v + 1) * dim];
        let dst = &mut i8_matrix[v * dim..(v + 1) * dim];
        let (sc, nm) = quantize_unit_f32_to_i8(row, dst, avx2_fma);
        scales[v] = sc;
        norms[v] = nm;
    }

    let keys_offset = HEADER_SIZE;
    let scales_offset = align64(keys_offset + count * KEY_SLOT_BYTES);
    let norms_offset = align64(scales_offset + count * 4);
    let i8_offset = align64(norms_offset + count * 4);
    let f32_offset = align64(i8_offset + count * dim);
    let footer_offset = f32_offset + count * dim * 4;
    let total_size = footer_offset + 4;

    let mut buf = vec![0u8; total_size];
    buf[0..8].copy_from_slice(MAGIC);
    buf[8..12].copy_from_slice(&FORMAT_VERSION.to_le_bytes());
    buf[12..16].copy_from_slice(&(dim as u32).to_le_bytes());
    buf[16..20].copy_from_slice(&(count as u32).to_le_bytes());
    buf[20..24].copy_from_slice(&(FLAG_HAS_I8 | FLAG_HAS_F32).to_le_bytes());
    buf[24..32].copy_from_slice(&generation.to_le_bytes());
    buf[32..40].copy_from_slice(&source_max_updated_at.to_le_bytes());
    let header_crc = crc32fast::hash(&buf[0..40]);
    buf[40..44].copy_from_slice(&header_crc.to_le_bytes());

    for (idx, key) in content_keys.iter().enumerate() {
        let bytes = key.as_bytes();
        let copy_len = bytes.len().min(KEY_SLOT_BYTES);
        let dst_start = keys_offset + idx * KEY_SLOT_BYTES;
        buf[dst_start..dst_start + copy_len].copy_from_slice(&bytes[..copy_len]);
    }
    for (idx, &sc) in scales.iter().enumerate() {
        let p = scales_offset + idx * 4;
        buf[p..p + 4].copy_from_slice(&sc.to_le_bytes());
    }
    for (idx, &nm) in norms.iter().enumerate() {
        let p = norms_offset + idx * 4;
        buf[p..p + 4].copy_from_slice(&nm.to_le_bytes());
    }
    let i8_as_u8 = unsafe { std::slice::from_raw_parts(i8_matrix.as_ptr() as *const u8, i8_matrix.len()) };
    buf[i8_offset..i8_offset + i8_as_u8.len()].copy_from_slice(i8_as_u8);

    let f32_as_u8 = unsafe {
        std::slice::from_raw_parts(f32_matrix.as_ptr() as *const u8, f32_matrix.len() * 4)
    };
    buf[f32_offset..f32_offset + f32_as_u8.len()].copy_from_slice(f32_as_u8);

    let footer_crc = crc32fast::hash(&buf[0..footer_offset]);
    buf[footer_offset..total_size].copy_from_slice(&footer_crc.to_le_bytes());

    let tmp_path = out_path.with_extension("t3vec.tmp");
    {
        let mut f = File::create(&tmp_path).map_err(|e| format!("create tmp failed: {e}"))?;
        f.write_all(&buf).map_err(|e| format!("write tmp failed: {e}"))?;
        f.sync_all().map_err(|e| format!("sync tmp failed: {e}"))?;
    }
    fs::rename(&tmp_path, out_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("atomic rename failed: {e}")
    })?;
    Ok(total_size)
}

struct PoolEntry {
    pool: Arc<MmapVectorPool>,
    last_used: Instant,
}

struct PoolManagerState {
    entries: HashMap<String, PoolEntry>,
    retired_files: Vec<PathBuf>,
    total_searches: u64,
}

static POOL_MANAGER: LazyLock<RwLock<PoolManagerState>> = LazyLock::new(|| {
    RwLock::new(PoolManagerState {
        entries: HashMap::new(),
        retired_files: Vec::new(),
        total_searches: 0,
    })
});

fn sweep_retired_files(retired: &mut Vec<PathBuf>) {
    retired.retain(|p| fs::remove_file(p).is_err() && p.exists());
}

fn evict_lru_if_needed(state: &mut PoolManagerState) {
    let now = Instant::now();
    let idle_keys: Vec<String> = state
        .entries
        .iter()
        .filter(|(_, e)| now.duration_since(e.last_used).as_secs() >= IDLE_EVICT_SECS)
        .map(|(k, _)| k.clone())
        .collect();
    for k in idle_keys {
        state.entries.remove(&k);
    }

    loop {
        let total_bytes: usize = state.entries.values().map(|e| e.pool.mapped_bytes).sum();
        if state.entries.len() <= MAX_RESIDENT_SCOPES && total_bytes <= MAX_RESIDENT_BYTES {
            break;
        }
        if state.entries.len() <= 1 {
            break;
        }
        if let Some(oldest_key) = state
            .entries
            .iter()
            .min_by_key(|(_, e)| e.last_used)
            .map(|(k, _)| k.clone())
        {
            state.entries.remove(&oldest_key);
        } else {
            break;
        }
    }
}

pub fn open_or_reload_pool(scope_key: &str, file_path: &Path) -> Result<(u64, i64, u32, u32), String> {
    let new_pool = Arc::new(MmapVectorPool::open(file_path)?);
    let info = (
        new_pool.generation,
        new_pool.source_max_updated_at,
        new_pool.count as u32,
        new_pool.dim as u32,
    );
    let mut state = POOL_MANAGER
        .write()
        .map_err(|_| "pool manager lock poisoned".to_string())?;
    if let Some(prev) = state.entries.insert(
        scope_key.to_owned(),
        PoolEntry {
            pool: new_pool,
            last_used: Instant::now(),
        },
    ) {
        if prev.pool.file_path != file_path {
            let old_path = prev.pool.file_path.clone();
            drop(prev);
            state.retired_files.push(old_path);
        }
    }
    evict_lru_if_needed(&mut state);
    sweep_retired_files(&mut state.retired_files);
    Ok(info)
}

pub fn search_loaded_pool(
    scope_key: &str,
    query: &[f32],
    top_k: usize,
    oversample: usize,
) -> Result<Option<Vec<VectorPoolHit>>, String> {
    let pool_opt = {
        let mut state = POOL_MANAGER
            .write()
            .map_err(|_| "pool manager lock poisoned".to_string())?;
        state.total_searches = state.total_searches.saturating_add(1);
        if let Some(entry) = state.entries.get_mut(scope_key) {
            entry.last_used = Instant::now();
            Some(Arc::clone(&entry.pool))
        } else {
            None
        }
    };
    match pool_opt {
        Some(pool) => Ok(Some(pool.search_two_stage(query, top_k, oversample)?)),
        None => Ok(None),
    }
}

pub fn close_loaded_pool(scope_key: &str) -> bool {
    if let Ok(mut state) = POOL_MANAGER.write() {
        let removed = state.entries.remove(scope_key).is_some();
        sweep_retired_files(&mut state.retired_files);
        removed
    } else {
        false
    }
}

pub fn close_all_loaded_pools() {
    if let Ok(mut state) = POOL_MANAGER.write() {
        state.entries.clear();
        sweep_retired_files(&mut state.retired_files);
    }
}

pub fn get_pool_metrics() -> PoolManagerMetrics {
    if let Ok(state) = POOL_MANAGER.read() {
        let total_mapped_bytes: u64 = state
            .entries
            .values()
            .map(|e| e.pool.mapped_bytes as u64)
            .sum();
        let total_vectors_mapped: u64 = state.entries.values().map(|e| e.pool.count as u64).sum();
        PoolManagerMetrics {
            open_scopes: state.entries.len() as u32,
            total_mapped_bytes,
            total_vectors_mapped,
            total_searches: state.total_searches,
        }
    } else {
        PoolManagerMetrics {
            open_scopes: 0,
            total_mapped_bytes: 0,
            total_vectors_mapped: 0,
            total_searches: 0,
        }
    }
}

/// Helper for computing normalized dot-product Top-K directly on an in-memory F32 slice.
pub fn cosine_top_k_in_memory(
    matrix: &[f32],
    dim: usize,
    query: &[f32],
    top_k: usize,
) -> Vec<(u32, f64)> {
    if dim == 0 || query.len() < dim {
        return Vec::new();
    }
    let q_slice = &query[..dim];
    let avx2_fma = has_avx2_fma();
    let q_norm = l2_norm_f32(q_slice, avx2_fma);
    if q_norm <= 1e-12 {
        return Vec::new();
    }
    let count = matrix.len() / dim;
    let k = top_k.max(1).min(count.max(1));
    let mut top: Vec<(usize, f32)> = Vec::with_capacity(k);
    for v in 0..count {
        let row = &matrix[v * dim..(v + 1) * dim];
        let r_norm = l2_norm_f32(row, avx2_fma);
        let sim = cosine_f32_best(row, q_slice, r_norm, q_norm, avx2_fma);
        push_top_k_usize(&mut top, k, v, sim);
    }
    top.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal).then_with(|| a.0.cmp(&b.0)));
    top.into_iter().map(|(i, s)| (i as u32, s as f64)).collect()
}
