use super::{bump_skip, base_ok, LimitsOut, SearchMatch, SearchRequest, SearchResponse};
use globset::{Glob, GlobSetBuilder};
use ignore::WalkBuilder;
use std::path::Path;
use std::time::Instant;

pub fn search_files(req: SearchRequest, limits: LimitsOut, started: Instant) -> SearchResponse {
    let mut resp = base_ok("files", "ignore", limits.clone(), started);
    let root = Path::new(&req.root);
    if !root.exists() {
        resp.ok = false;
        resp.errors.push("root_missing".to_string());
        resp.duration_ms = started.elapsed().as_millis() as u64;
        return resp;
    }

    let include = build_globset(req.include.as_deref().unwrap_or(&[]));
    let exclude = build_globset(req.exclude.as_deref().unwrap_or(&[]));
    let query = req
        .query
        .as_deref()
        .or(req.pattern.as_deref())
        .unwrap_or("")
        .to_lowercase();

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

    let mut paths: Vec<String> = Vec::new();
    for entry in walker.build() {
        if paths.len() >= resp.limits.max_files {
            resp.truncated = true;
            break;
        }
        if started.elapsed().as_millis() as u64 > resp.limits.timeout_ms {
            resp.timeout = true;
            resp.truncated = true;
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                bump_skip(&mut resp.skipped, "walk_error");
                continue;
            }
        };
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let abs = entry.path();
        let rel = match abs.strip_prefix(root) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        resp.scanned.files += 1;
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
        if !query.is_empty() && !rel.to_lowercase().contains(&query) {
            continue;
        }
        paths.push(rel);
    }
    paths.sort();
    if paths.len() > resp.limits.max_matches {
        paths.truncate(resp.limits.max_matches);
        resp.truncated = true;
    }
    resp.matches = paths
        .into_iter()
        .map(|path| SearchMatch {
            path,
            line: None,
            column: None,
            text: None,
            confidence: "file_path".to_string(),
        })
        .collect();
    resp.confidence = "file_path".to_string();
    resp.duration_ms = started.elapsed().as_millis() as u64;
    resp
}

fn build_globset(patterns: &[String]) -> Option<globset::GlobSet> {
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
