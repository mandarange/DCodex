mod search;

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--version") => println!("sks-rs {}", env!("CARGO_PKG_VERSION")),
        Some("search") => {
            let rest: Vec<String> = args.collect();
            std::process::exit(search::run(&rest));
        }
        Some("compact-info") => {
            let mut input = String::new();
            let _ = io::stdin().read_to_string(&mut input);
            println!("{{\"ok\":true,\"engine\":\"rust\",\"input_bytes\":{}}}", input.as_bytes().len());
        }
        Some("jsonl-tail") => {
            let path = args.next().unwrap_or_default();
            let mut bytes: u64 = 262144;
            while let Some(arg) = args.next() {
                if arg == "--bytes" {
                    if let Some(raw) = args.next() {
                        bytes = raw.parse().unwrap_or(bytes);
                    }
                }
            }
            match tail_file(&path, bytes) {
                Ok(text) => print!("{}", text),
                Err(err) => {
                    eprintln!("{}", err);
                    std::process::exit(1);
                }
            }
        }
        Some("image-hash") | Some("image-voxel-index") => {
            let path = args.next().unwrap_or_default();
            match image_hash(&path) {
                Ok((sha, bytes)) => println!("{{\"ok\":true,\"engine\":\"rust\",\"path\":\"{}\",\"sha256\":\"{}\",\"bytes\":{}}}", json_escape(&path), sha, bytes),
                Err(err) => {
                    println!("{{\"ok\":false,\"engine\":\"rust\",\"path\":\"{}\",\"error\":\"{}\"}}", json_escape(&path), json_escape(&err.to_string()));
                    std::process::exit(1);
                }
            }
        }
        Some("voxel-validate") | Some("image-voxel-validate-fast") => {
            let path = args.next().unwrap_or_default();
            let mut require_anchors = false;
            let mut require_relations = false;
            while let Some(arg) = args.next() {
                if arg == "--require-anchors" { require_anchors = true; }
                if arg == "--require-relations" { require_relations = true; }
            }
            match std::fs::read_to_string(&path) {
                Ok(text) => {
                    let report = voxel_validate(&text, require_anchors, require_relations);
                    println!("{}", report);
                    if report.contains("\"ok\":false") { std::process::exit(1); }
                }
                Err(err) => {
                    println!("{{\"ok\":false,\"engine\":\"rust\",\"issues\":[\"read_error\"],\"error\":\"{}\"}}", json_escape(&err.to_string()));
                    std::process::exit(1);
                }
            }
        }
        Some("secret-scan") | Some("evidence-secret-scan") => {
            let path = args.next().unwrap_or_default();
            match std::fs::read_to_string(&path) {
                Ok(text) => {
                    let found = ["CODEX_ACCESS_TOKEN", "OPENAI_API_KEY", "CODEX_LB_API_KEY", "sk-proj-", "sk-clb-", "github_pat_"]
                        .iter()
                        .any(|needle| text.contains(needle));
                    println!("{{\"ok\":{},\"engine\":\"rust\",\"findings\":{}}}", if found { "false" } else { "true" }, if found { 1 } else { 0 });
                    if found { std::process::exit(1); }
                }
                Err(err) => {
                    eprintln!("{}", err);
                    std::process::exit(1);
                }
            }
        }
        _ => {
            eprintln!("sks-rs optional accelerator. Commands: --version, search files|text|batch, compact-info, jsonl-tail, secret-scan, evidence-secret-scan, image-hash, image-voxel-index, voxel-validate, image-voxel-validate-fast");
            std::process::exit(2);
        }
    }
}

fn image_hash(path: &str) -> io::Result<(String, u64)> {
    let mut file = File::open(path)?;
    let mut data = Vec::new();
    file.read_to_end(&mut data)?;
    let bytes = data.len() as u64;
    Ok((sha256_hex(&data), bytes))
}

fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    let mut h: [u32; 8] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    let bit_len = (data.len() as u64) * 8;
    let mut msg = data.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 { msg.push(0); }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) = (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    h.iter().map(|x| format!("{:08x}", x)).collect::<String>()
}

fn voxel_validate(text: &str, require_anchors: bool, require_relations: bool) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(err) => {
            return format!("{{\"ok\":false,\"engine\":\"rust\",\"schema\":\"sks.image-voxel-ledger.v1\",\"images\":0,\"anchors\":0,\"relations\":0,\"issues\":[\"json_parse\"],\"error\":\"{}\"}}", json_escape(&err.to_string()));
        }
    };
    let mut issues: Vec<String> = Vec::new();
    if parsed.get("schema").and_then(|v| v.as_str()) != Some("sks.image-voxel-ledger.v1") { issues.push("schema".to_string()); }
    let images = parsed.get("images").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let anchors = parsed.get("anchors").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let relations = parsed.get("relations").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if !parsed.get("images").map(|v| v.is_array()).unwrap_or(false) { issues.push("missing_images".to_string()); }
    if !parsed.get("anchors").map(|v| v.is_array()).unwrap_or(false) { issues.push("missing_anchors".to_string()); }
    if require_anchors && anchors.is_empty() { issues.push("missing_anchors:visual-route".to_string()); }
    if require_relations && relations.is_empty() { issues.push("missing_relations:visual-route".to_string()); }
    let mut image_ids: Vec<String> = Vec::new();
    let mut anchor_ids: Vec<String> = Vec::new();
    for image in &images {
        let id = image.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() { issues.push("image_id".to_string()); }
        if !id.is_empty() && image_ids.iter().any(|x| x == id) { issues.push(format!("duplicate_image:{}", id)); }
        if !id.is_empty() { image_ids.push(id.to_string()); }
        if image.get("path").and_then(|v| v.as_str()).unwrap_or("").is_empty() { issues.push(format!("image_path:{}", if id.is_empty() { "unknown" } else { id })); }
        if image.get("sha256").and_then(|v| v.as_str()).unwrap_or("").is_empty() { issues.push(format!("image_sha256:{}", if id.is_empty() { "unknown" } else { id })); }
        let w = image.get("width").and_then(|v| v.as_f64());
        let h = image.get("height").and_then(|v| v.as_f64());
        if !w.map(|n| n.is_finite()).unwrap_or(false) || !h.map(|n| n.is_finite()).unwrap_or(false) {
            issues.push(format!("image_dimensions:{}", if id.is_empty() { "unknown" } else { id }));
        }
    }
    for anchor in &anchors {
        let id = anchor.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if id.is_empty() { issues.push("anchor_id".to_string()); }
        if !id.is_empty() && anchor_ids.iter().any(|x| x == id) { issues.push(format!("duplicate_anchor:{}", id)); }
        if !id.is_empty() { anchor_ids.push(id.to_string()); }
        let image_id = anchor.get("image_id").and_then(|v| v.as_str()).unwrap_or("");
        if image_id.is_empty() || !image_ids.iter().any(|x| x == image_id) { issues.push(format!("anchor_image_ref:{}", if id.is_empty() { "unknown" } else { id })); }
        let image = images.iter().find(|img| img.get("id").and_then(|v| v.as_str()) == Some(image_id));
        let w = image.and_then(|img| img.get("width")).and_then(|v| v.as_f64()).unwrap_or(f64::NAN);
        let h = image.and_then(|img| img.get("height")).and_then(|v| v.as_f64()).unwrap_or(f64::NAN);
        match anchor.get("bbox").and_then(|v| v.as_array()) {
            Some(bbox) if bbox.len() == 4 => {
                let vals: Vec<f64> = bbox.iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect();
                if vals.iter().any(|n| !n.is_finite()) { issues.push(format!("bbox_number:{}", if id.is_empty() { "unknown" } else { id })); }
                if vals[2] <= 0.0 || vals[3] <= 0.0 { issues.push(format!("bbox_positive:{}", if id.is_empty() { "unknown" } else { id })); }
                if w.is_finite() && vals[0] + vals[2] > w {
                    issues.push(format!("bbox_width_out_of_bounds:{}", if id.is_empty() { "unknown" } else { id }));
                }
                if h.is_finite() && vals[1] + vals[3] > h {
                    issues.push(format!("bbox_height_out_of_bounds:{}", if id.is_empty() { "unknown" } else { id }));
                }
            }
            Some(_) => issues.push(format!("bbox_shape:{}", if id.is_empty() { "unknown" } else { id })),
            None => issues.push(format!("anchor_bbox:{}", if id.is_empty() { "unknown" } else { id })),
        }
    }
    for relation in &relations {
        if let Some(before) = relation.get("before_image_id").and_then(|v| v.as_str()) {
            if !image_ids.iter().any(|x| x == before) { issues.push(format!("relation_before:{}", before)); }
        }
        if let Some(after) = relation.get("after_image_id").and_then(|v| v.as_str()) {
            if !image_ids.iter().any(|x| x == after) { issues.push(format!("relation_after:{}", after)); }
        }
        let changed = relation.get("changed_anchor_ids").or_else(|| relation.get("anchors")).and_then(|v| v.as_array()).cloned().unwrap_or_default();
        for anchor_id in changed.iter().filter_map(|v| v.as_str()) {
            if !anchor_ids.iter().any(|x| x == anchor_id) { issues.push(format!("relation_anchor:{}", anchor_id)); }
        }
    }
    issues.sort();
    issues.dedup();
    let ok = issues.is_empty();
    let issue_json = issues.iter().map(|x| format!("\"{}\"", json_escape(x))).collect::<Vec<_>>().join(",");
    format!("{{\"ok\":{},\"engine\":\"rust\",\"schema\":\"sks.image-voxel-ledger.v1\",\"images\":{},\"anchors\":{},\"relations\":{},\"issues\":[{}]}}", if ok { "true" } else { "false" }, images.len(), anchors.len(), relations.len(), issue_json)
}

fn json_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n").replace('\r', "\\r")
}

fn tail_file(path: &str, bytes: u64) -> io::Result<String> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(bytes);
    file.seek(SeekFrom::Start(start))?;
    let mut out = String::new();
    file.read_to_string(&mut out)?;
    Ok(out)
}
