//! nsm-attest: Minimal NSM attestation helper for Nitro Enclaves.
//!
//! Reads user_data from stdin (raw bytes), sends an NSM Attestation request via
//! /dev/nsm, and writes the COSE_Sign1 document to stdout.
//!
//! Usage: echo -n <user_data> | nsm-attest

use std::io::{self, Read, Write};
use std::process::ExitCode;

use aws_nitro_enclaves_nsm_api::api::{Request, Response};
use aws_nitro_enclaves_nsm_api::driver::{nsm_exit, nsm_init, nsm_process_request};
use serde_bytes::ByteBuf;

fn run() -> Result<(), String> {
    if std::env::args().len() > 1 {
        return Err("takes no arguments".into());
    }

    let mut user_data = Vec::new();
    io::stdin().read_to_end(&mut user_data).map_err(|e| format!("stdin: {e}"))?;

    let fd = nsm_init();
    if fd < 0 {
        return Err(format!("nsm_init failed (fd={fd})"));
    }

    let request = Request::Attestation {
        user_data: (!user_data.is_empty()).then(|| ByteBuf::from(user_data)),
        nonce: None,
        public_key: None,
    };

    let response = nsm_process_request(fd, request);
    nsm_exit(fd);

    match response {
        Response::Attestation { document } => {
            io::stdout().write_all(&document).map_err(|e| format!("stdout: {e}"))?;
            Ok(())
        }
        Response::Error(code) => Err(format!("NSM error: {code:?}")),
        other => Err(format!("unexpected NSM response: {other:?}")),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("nsm-attest: {e}");
            ExitCode::FAILURE
        }
    }
}
