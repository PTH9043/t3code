//! Pool 1: Request-Scoped Bump Arena (`bumpalo::Bump`) for RAG text compression,
//! Korean/English 2-char bigram extraction, and near-duplicate Jaccard filtering.
//!
//! Safety cap: If a single batch expands the arena past `ARENA_SHRINK_THRESHOLD_BYTES` (4 MiB),
//! the arena is replaced with a fresh 256 KiB arena on completion so peak memory never leaks.

use bumpalo::Bump;
use std::cell::RefCell;
use std::collections::HashSet;

const ARENA_BASE_CAPACITY_BYTES: usize = 256 * 1024;
const ARENA_SHRINK_THRESHOLD_BYTES: usize = 4 * 1024 * 1024;

thread_local! {
    static SCRATCH_ARENA: RefCell<Bump> = RefCell::new(Bump::with_capacity(ARENA_BASE_CAPACITY_BYTES));
}

pub struct ArenaCompressionOutput {
    pub compressed_docs: Vec<String>,
    pub total_unique_bigrams: u32,
    pub total_compressed_bytes: u32,
    pub arena_allocated_bytes: u32,
}

fn is_decorative_divider_line(trimmed: &str) -> bool {
    let char_count = trimmed.chars().count();
    if char_count < 3 {
        return false;
    }
    let all_ascii_div = char_count >= 4
        && trimmed
            .bytes()
            .all(|b| matches!(b, b'-' | b'=' | b'_' | b'*' | b'~' | b'`' | b'#'));
    if all_ascii_div {
        return true;
    }
    trimmed
        .chars()
        .all(|c| matches!(c, '─' | '━' | '═' | '┄' | '┅' | '┈' | '┉'))
}

fn collapse_whitespace_lower<'a>(s: &str, arena: &'a Bump) -> &'a str {
    let mut out = bumpalo::collections::String::with_capacity_in(s.len(), arena);
    let mut prev_ws = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_ws && !out.is_empty() {
                out.push(' ');
                prev_ws = true;
            }
        } else {
            for lc in ch.to_lowercase() {
                out.push(lc);
            }
            prev_ws = false;
        }
    }
    if out.ends_with(' ') {
        out.pop();
    }
    out.into_bump_str()
}

fn compress_single_in_arena(doc: &str, max_chars: Option<usize>, arena: &Bump) -> String {
    if doc.is_empty() {
        return String::new();
    }
    let mut kept: bumpalo::collections::Vec<&str> = bumpalo::collections::Vec::new_in(arena);
    let mut seen_long: HashSet<&str> = HashSet::with_capacity(64);
    let mut consecutive_blanks: u32 = 0;

    for raw_line in doc.lines() {
        let trimmed_right = raw_line.trim_end();
        let trimmed = trimmed_right.trim();
        if trimmed.is_empty() {
            consecutive_blanks += 1;
            if consecutive_blanks <= 1 && !kept.is_empty() {
                kept.push("");
            }
            continue;
        }
        if is_decorative_divider_line(trimmed) {
            continue;
        }
        let norm_key = collapse_whitespace_lower(trimmed, arena);
        if norm_key.chars().count() >= 14 && !seen_long.insert(norm_key) {
            continue;
        }
        consecutive_blanks = 0;
        kept.push(trimmed_right);
    }

    while matches!(kept.last(), Some(&"")) {
        kept.pop();
    }

    let mut compacted = bumpalo::collections::String::with_capacity_in(doc.len(), arena);
    for (idx, line) in kept.iter().enumerate() {
        if idx > 0 {
            compacted.push('\n');
        }
        compacted.push_str(line);
    }

    if let Some(limit) = max_chars {
        if limit > 40 {
            let total_chars = compacted.chars().count();
            if total_chars > limit {
                let target_chars = limit.saturating_sub(10);
                let byte_cut = compacted
                    .char_indices()
                    .nth(target_chars)
                    .map(|(idx, _)| idx)
                    .unwrap_or(compacted.len());
                let slice = &compacted[..byte_cut];
                let min_boundary_chars = (limit * 55) / 100;
                let mut best_byte: Option<usize> = None;
                for pat in ["\n", ". ", "다. ", "! ", "? "] {
                    if let Some(pos) = slice.rfind(pat) {
                        let candidate = pos + if pat == "다. " { "다.".len() } else { 1 };
                        let chars_before = slice[..candidate].chars().count();
                        if chars_before >= min_boundary_chars {
                            best_byte = Some(best_byte.map_or(candidate, |prev| prev.max(candidate)));
                        }
                    }
                }
                let final_cut = best_byte.unwrap_or(slice.len());
                let mut result = String::with_capacity(final_cut + 20);
                result.push_str(slice[..final_cut].trim_end());
                result.push_str("… [압축됨]");
                return result;
            }
        }
    }

    compacted.as_str().to_owned()
}

pub fn run_compress_and_bigram_batch(
    docs: &[String],
    max_chars: Option<usize>,
    return_compressed: bool,
) -> ArenaCompressionOutput {
    SCRATCH_ARENA.with(|cell| {
        let mut arena = cell.borrow_mut();
        arena.reset();

        let mut compressed_docs = if return_compressed {
            Vec::with_capacity(docs.len())
        } else {
            Vec::new()
        };
        let mut total_unique_bigrams: u32 = 0;
        let mut total_compressed_bytes: u32 = 0;
        let mut bigram_set: HashSet<(char, char)> = HashSet::with_capacity(256);

        for doc in docs {
            let compacted = compress_single_in_arena(doc, max_chars, &arena);
            total_compressed_bytes = total_compressed_bytes.saturating_add(compacted.len() as u32);

            bigram_set.clear();
            let mut prev_char: Option<char> = None;
            for ch in compacted.chars() {
                if ch.is_alphanumeric() || ch == '_' || ch == '-' {
                    let lower = ch.to_ascii_lowercase();
                    if let Some(p) = prev_char {
                        bigram_set.insert((p, lower));
                    }
                    prev_char = Some(lower);
                } else {
                    prev_char = None;
                }
            }
            total_unique_bigrams = total_unique_bigrams.saturating_add(bigram_set.len() as u32);
            if return_compressed {
                compressed_docs.push(compacted);
            }
        }

        let allocated = arena.allocated_bytes() as u32;
        if arena.allocated_bytes() > ARENA_SHRINK_THRESHOLD_BYTES {
            *arena = Bump::with_capacity(ARENA_BASE_CAPACITY_BYTES);
        } else {
            arena.reset();
        }

        ArenaCompressionOutput {
            compressed_docs,
            total_unique_bigrams,
            total_compressed_bytes,
            arena_allocated_bytes: allocated,
        }
    })
}

/// Computes a boolean mask where `true` means `docs[i]` is a near-duplicate (>= `threshold`
/// token-set Jaccard overlap) of an earlier accepted document (`length >= 80` chars).
pub fn compute_near_duplicate_mask(docs: &[String], threshold: f64) -> Vec<bool> {
    let mut accepted: Vec<HashSet<String>> = Vec::with_capacity(docs.len());
    let mut mask = Vec::with_capacity(docs.len());

    for doc in docs {
        let char_len = doc.chars().count();
        let mut tok_set: HashSet<String> = HashSet::with_capacity(64);
        let mut cur = String::new();
        for ch in doc.chars() {
            if ch.is_alphanumeric() || ch == '_' || ch == '-' {
                for lc in ch.to_lowercase() {
                    cur.push(lc);
                }
            } else if !cur.is_empty() {
                if cur.chars().count() >= 2 {
                    tok_set.insert(std::mem::take(&mut cur));
                    if tok_set.len() >= 120 {
                        break;
                    }
                } else {
                    cur.clear();
                }
            }
        }
        if !cur.is_empty() && cur.chars().count() >= 2 && tok_set.len() < 120 {
            tok_set.insert(cur);
        }

        if char_len < 80 || tok_set.len() < 8 {
            mask.push(false);
            accepted.push(tok_set);
            continue;
        }

        let mut dup = false;
        for prev in &accepted {
            if prev.len() < 8 {
                continue;
            }
            let (small, large) = if tok_set.len() <= prev.len() {
                (&tok_set, prev)
            } else {
                (prev, &tok_set)
            };
            let inter = small.iter().filter(|t| large.contains(*t)).count();
            let union = tok_set.len() + prev.len() - inter;
            if union > 0 && (inter as f64 / union as f64) >= threshold {
                dup = true;
                break;
            }
        }
        mask.push(dup);
        if !dup {
            accepted.push(tok_set);
        }
    }
    mask
}
