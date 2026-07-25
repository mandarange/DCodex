use super::{bump_skip, base_ok, LimitsOut, SearchMatch, SearchRequest, SearchResponse};
use globset::{Glob, GlobSet, GlobSetBuilder};
use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{SearcherBuilder, sinks};
use ignore::WalkBuilder;
use std::path::Path;
use std::time::Instant;

pub fn search_text(req: SearchRequest, limits: LimitsOut, started: Instant) -> SearchResponse {
    let mut resp = base_ok("text", "grep-searcher", limits.clone(), started);
    let pattern = req
        .pattern
        .as_deref()
        .or(req.query.as_deref())
        .unwrap_or("")
        .to_string();
    if pattern.is_empty() {
        resp.ok = false;
        resp.errors.push("missing_pattern".to_string());
        resp.duration_ms = started.elapsed().as_millis() as u64;
        return resp;
    }

    let case_sensitive = req.case_sensitive.unwrap_or(true);
    let matcher = match RegexMatcherBuilder::new()
        .case_insensitive(!case_sensitive)
        .multi_line(false)
        .build(&pattern)
    {
        Ok(m) => m,
        Err(e) => {
            resp.ok = false;
            resp.errors.push(format!("invalid_regex:{}", e));
            resp.duration_ms = started.elapsed().as_millis() as u64;
            return resp;
        }
    };

    let root = Path::new(&req.root);
    let include = build_globset(req.include.as_deref().unwrap_or(&[]));
    let exclude = build_globset(req.exclude.as_deref().unwrap_or(&[]));
    let max_matches = resp.limits.max_matches;
    let max_bytes = resp.limits.max_bytes;
    let timeout_ms = resp.limits.timeout_ms;

    let mut walker = WalkBuilder::new(root);
    walker
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .follow_links(false)
        .max_depth(Some(40))
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            name != ".git" && name != "node_modules" && name != "dist" && name != "target"
        });

    let mut searcher = SearcherBuilder::new()
        .binary_detection(grep_searcher::BinaryDetection::quit(b'\x00'))
        .build();
    let mut matches: Vec<SearchMatch> = Vec::new();
    let mut truncated = false;

    for entry in walker.build() {
        if matches.len() >= max_matches {
            truncated = true;
            break;
        }
        if started.elapsed().as_millis() as u64 > timeout_ms {
            resp.timeout = true;
            truncated = true;
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                bump_skip(&mut resp.skipped, "walk_error");
                continue;
            }
        };
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let abs = entry.path();
        let rel = match abs.strip_prefix(root) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if let Some(set) = &exclude {
            if set.is_match(&rel) {
                bump_skip(&mut resp.skipped, "exclude");
                continue;
            }
        }
        if let Some(set) = &include {
            if !set.is_match(&rel) {
                bump_skip(&mut resp.skipped, "include");
                continue;
            }
        }
        let meta = match abs.metadata() {
            Ok(m) => m,
            Err(_) => {
                bump_skip(&mut resp.skipped, "stat");
                continue;
            }
        };
        if meta.len() > max_bytes {
            bump_skip(&mut resp.skipped, "too_large");
            continue;
        }
        resp.scanned.files += 1;
        resp.scanned.bytes += meta.len();

        let mut per_file = 0usize;
        let rel_for_sink = rel.clone();
        let sink_truncated = std::cell::Cell::new(false);
        let result = searcher.search_path(
            &matcher,
            abs,
            sinks::UTF8(|line_num, line| {
                if matches.len() >= max_matches || per_file >= 50 {
                    sink_truncated.set(true);
                    return Ok(false);
                }
                let mut col = 1u32;
                if let Ok(Some(m)) = matcher.find(line.as_bytes()) {
                    col = (m.start() as u32) + 1;
                }
                matches.push(SearchMatch {
                    path: rel_for_sink.clone(),
                    line: Some(line_num as u32),
                    column: Some(col),
                    text: Some(line.chars().take(240).collect()),
                    confidence: "text_candidate".to_string(),
                });
                per_file += 1;
                Ok(true)
            }),
        );
        if sink_truncated.get() {
            truncated = true;
        }
        if result.is_err() {
            bump_skip(&mut resp.skipped, "search_error");
        }
    }

    matches.sort_by(|a, b| {
        a.path
            .cmp(&b.path)
            .then(a.line.unwrap_or(0).cmp(&b.line.unwrap_or(0)))
            .then(a.column.unwrap_or(0).cmp(&b.column.unwrap_or(0)))
    });
    resp.matches = matches;
    resp.truncated = truncated;
    resp.confidence = "text_candidate".to_string();
    resp.duration_ms = started.elapsed().as_millis() as u64;
    resp
}

fn build_globset(patterns: &[String]) -> Option<GlobSet> {
    if patterns.is_empty() {
        return None;
    }
    let mut builder = GlobSetBuilder::new();
    for p in patterns {
        if let Ok(g) = Glob::new(p) {
            builder.add(g);
        }
    }
    builder.build().ok()
}
