//! SIMD-accelerated vector kernels (AVX2+FMA on x86_64, 8-lane unrolled scalar fallback).
//! All kernels guard against NaN/Inf/zero-norm inputs and never invoke UB.

#[inline(always)]
pub fn dot_f32_scalar(a: &[f32], b: &[f32]) -> f32 {
    let len = a.len().min(b.len());
    let (mut s0, mut s1, mut s2, mut s3) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    let (mut s4, mut s5, mut s6, mut s7) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    let mut i = 0usize;
    let limit = len & !7;
    while i < limit {
        s0 += a[i] * b[i];
        s1 += a[i + 1] * b[i + 1];
        s2 += a[i + 2] * b[i + 2];
        s3 += a[i + 3] * b[i + 3];
        s4 += a[i + 4] * b[i + 4];
        s5 += a[i + 5] * b[i + 5];
        s6 += a[i + 6] * b[i + 6];
        s7 += a[i + 7] * b[i + 7];
        i += 8;
    }
    let mut sum = (s0 + s1) + (s2 + s3) + (s4 + s5) + (s6 + s7);
    while i < len {
        sum += a[i] * b[i];
        i += 1;
    }
    sum
}

#[inline(always)]
pub fn dot_i8_scalar(a: &[i8], b: &[i8]) -> i32 {
    let len = a.len().min(b.len());
    let (mut s0, mut s1, mut s2, mut s3) = (0i32, 0i32, 0i32, 0i32);
    let (mut s4, mut s5, mut s6, mut s7) = (0i32, 0i32, 0i32, 0i32);
    let mut i = 0usize;
    let limit = len & !7;
    while i < limit {
        s0 += (a[i] as i32) * (b[i] as i32);
        s1 += (a[i + 1] as i32) * (b[i + 1] as i32);
        s2 += (a[i + 2] as i32) * (b[i + 2] as i32);
        s3 += (a[i + 3] as i32) * (b[i + 3] as i32);
        s4 += (a[i + 4] as i32) * (b[i + 4] as i32);
        s5 += (a[i + 5] as i32) * (b[i + 5] as i32);
        s6 += (a[i + 6] as i32) * (b[i + 6] as i32);
        s7 += (a[i + 7] as i32) * (b[i + 7] as i32);
        i += 8;
    }
    let mut sum = (s0 + s1) + (s2 + s3) + (s4 + s5) + (s6 + s7);
    while i < len {
        sum += (a[i] as i32) * (b[i] as i32);
        i += 1;
    }
    sum
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2", enable = "fma")]
unsafe fn dot_f32_avx2(a: &[f32], b: &[f32]) -> f32 {
    use std::arch::x86_64::*;
    let len = a.len().min(b.len());
    let mut acc0 = _mm256_setzero_ps();
    let mut acc1 = _mm256_setzero_ps();
    let mut acc2 = _mm256_setzero_ps();
    let mut acc3 = _mm256_setzero_ps();
    let mut i = 0usize;
    let a_ptr = a.as_ptr();
    let b_ptr = b.as_ptr();
    unsafe {
        while i + 32 <= len {
            acc0 = _mm256_fmadd_ps(
                _mm256_loadu_ps(a_ptr.add(i)),
                _mm256_loadu_ps(b_ptr.add(i)),
                acc0,
            );
            acc1 = _mm256_fmadd_ps(
                _mm256_loadu_ps(a_ptr.add(i + 8)),
                _mm256_loadu_ps(b_ptr.add(i + 8)),
                acc1,
            );
            acc2 = _mm256_fmadd_ps(
                _mm256_loadu_ps(a_ptr.add(i + 16)),
                _mm256_loadu_ps(b_ptr.add(i + 16)),
                acc2,
            );
            acc3 = _mm256_fmadd_ps(
                _mm256_loadu_ps(a_ptr.add(i + 24)),
                _mm256_loadu_ps(b_ptr.add(i + 24)),
                acc3,
            );
            i += 32;
        }
        let acc = _mm256_add_ps(_mm256_add_ps(acc0, acc1), _mm256_add_ps(acc2, acc3));
        let mut buf = [0.0f32; 8];
        _mm256_storeu_ps(buf.as_mut_ptr(), acc);
        let mut sum = buf.iter().copied().sum::<f32>();
        while i < len {
            sum += *a_ptr.add(i) * *b_ptr.add(i);
            i += 1;
        }
        sum
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn dot_i8_avx2(a: &[i8], b: &[i8]) -> i32 {
    use std::arch::x86_64::*;
    let len = a.len().min(b.len());
    let mut acc = _mm256_setzero_si256();
    let mut i = 0usize;
    let a_ptr = a.as_ptr();
    let b_ptr = b.as_ptr();
    unsafe {
        while i + 16 <= len {
            let va = _mm256_cvtepi8_epi16(_mm_loadu_si128(a_ptr.add(i) as *const __m128i));
            let vb = _mm256_cvtepi8_epi16(_mm_loadu_si128(b_ptr.add(i) as *const __m128i));
            acc = _mm256_add_epi32(acc, _mm256_madd_epi16(va, vb));
            i += 16;
        }
        let mut buf = [0i32; 8];
        _mm256_storeu_si256(buf.as_mut_ptr() as *mut __m256i, acc);
        let mut sum: i32 = buf.iter().sum();
        while i < len {
            sum += (*a_ptr.add(i) as i32) * (*b_ptr.add(i) as i32);
            i += 1;
        }
        sum
    }
}

#[inline(always)]
pub fn has_avx2_fma() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        is_x86_feature_detected!("avx2") && is_x86_feature_detected!("fma")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}

#[inline(always)]
pub fn has_avx2() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        is_x86_feature_detected!("avx2")
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        false
    }
}

#[inline(always)]
pub fn dot_f32_best(a: &[f32], b: &[f32], avx2_fma: bool) -> f32 {
    let val = if avx2_fma {
        #[cfg(target_arch = "x86_64")]
        unsafe {
            dot_f32_avx2(a, b)
        }
        #[cfg(not(target_arch = "x86_64"))]
        dot_f32_scalar(a, b)
    } else {
        dot_f32_scalar(a, b)
    };
    if val.is_finite() { val } else { 0.0 }
}

#[inline(always)]
pub fn dot_i8_best(a: &[i8], b: &[i8], avx2: bool) -> i32 {
    if avx2 {
        #[cfg(target_arch = "x86_64")]
        unsafe {
            dot_i8_avx2(a, b)
        }
        #[cfg(not(target_arch = "x86_64"))]
        dot_i8_scalar(a, b)
    } else {
        dot_i8_scalar(a, b)
    }
}

#[inline(always)]
pub fn l2_norm_f32(v: &[f32], avx2_fma: bool) -> f32 {
    let sq = dot_f32_best(v, v, avx2_fma);
    if sq > 0.0 && sq.is_finite() {
        sq.sqrt()
    } else {
        0.0
    }
}

/// True normalized cosine similarity `[-1.0, 1.0]` with NaN/zero-norm guard.
#[inline(always)]
pub fn cosine_f32_best(a: &[f32], b: &[f32], norm_a: f32, norm_b: f32, avx2_fma: bool) -> f32 {
    if norm_a <= 1e-12 || norm_b <= 1e-12 {
        return 0.0;
    }
    let dot = dot_f32_best(a, b, avx2_fma);
    let sim = dot / (norm_a * norm_b);
    if sim.is_finite() {
        sim.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

/// Quantize an F32 vector into signed Int8 (symmetric scalar quantization) after L2 normalization.
/// Returns `(quant_scale, l2_norm)`. Storing unit-normalized Int8 vectors ensures
/// Int8 dot products directly approximate true cosine similarity regardless of vector magnitude.
pub fn quantize_unit_f32_to_i8(src: &[f32], dst: &mut [i8], avx2_fma: bool) -> (f32, f32) {
    let norm = l2_norm_f32(src, avx2_fma);
    if norm <= 1e-12 {
        dst.fill(0);
        return (1.0, 0.0);
    }
    let inv_norm = 1.0 / norm;
    let mut max_abs = 0.0f32;
    for &v in src {
        if v.is_finite() {
            let a = (v * inv_norm).abs();
            if a > max_abs {
                max_abs = a;
            }
        }
    }
    let scale = if max_abs > 1e-8 { max_abs / 127.0 } else { 1.0 };
    let factor = inv_norm / scale;
    for (d, &v) in dst.iter_mut().zip(src.iter()) {
        let clamped = if v.is_finite() {
            (v * factor).round().clamp(-127.0, 127.0) as i8
        } else {
            0i8
        };
        *d = clamped;
    }
    (scale, norm)
}

/// Hardware-accelerated 64-bit POPCNT Hamming distance on 1-bit binary quantized vectors.
#[inline(always)]
pub fn hamming_binary_fast(a: &[u8], b: &[u8]) -> u32 {
    let len = a.len().min(b.len());
    let mut dist = 0u32;
    let mut i = 0usize;
    while i + 8 <= len {
        let wa = u64::from_le_bytes(a[i..i + 8].try_into().unwrap_or([0; 8]));
        let wb = u64::from_le_bytes(b[i..i + 8].try_into().unwrap_or([0; 8]));
        dist += (wa ^ wb).count_ones();
        i += 8;
    }
    while i < len {
        dist += (a[i] ^ b[i]).count_ones();
        i += 1;
    }
    for &x in &a[len..] {
        dist += x.count_ones();
    }
    for &x in &b[len..] {
        dist += x.count_ones();
    }
    dist
}
