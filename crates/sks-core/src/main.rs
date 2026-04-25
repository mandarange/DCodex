use std::io::{self, Read};

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--version") => println!("sks-core 0.3.0"),
        Some("compact-info") => {
            let mut input = String::new();
            let _ = io::stdin().read_to_string(&mut input);
            println!("{{\"ok\":true,\"engine\":\"rust\",\"input_bytes\":{}}}", input.as_bytes().len());
        }
        _ => {
            eprintln!("sks-core optional accelerator. Commands: --version, compact-info");
            std::process::exit(2);
        }
    }
}
