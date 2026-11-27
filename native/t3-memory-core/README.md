# `native/t3-memory-core` (Rust + napi-rs Arena & SIMD PoC)

T3 메모리/RAG 핫패스 전용 최소 Rust 네이티브 PoC 모듈입니다.

- **Pool 1 (Bump Arena, `bumpalo`)**: `compressAndBigramBatchArena` — 요청 단위 스크래치 풀에서 텍스트 압축·한국어/영문 바이그램 추출 후 `O(1)` 리셋(V8 GC 압박 0).
- **Pool 2 (Zero-Copy SIMD / Int8 양자화 벡터 풀)**: `cosineTopKF32`, `quantizeF32ToI8`, `cosineTopKI8` — Node.js `Float32Array`/`Int8Array`를 복사 없이 AVX2+FMA SIMD로 Top-K 검색(`Int8` 양자화 시 RAM 4배 절감).

## 빌드 및 벤치마크

```powershell
cargo build --manifest-path native/t3-memory-core/Cargo.toml --release
Copy-Item native/t3-memory-core/target/release/t3_memory_core.dll native/t3-memory-core/t3_memory_core.node -Force
node native/t3-memory-core/bench.mjs
```
