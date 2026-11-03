//! nsm-describe-pcrs: Issue NSM DescribePCR for indices 0..=2 and report lock state.
//!
//! Exit code:
//!   0  every PCR 0..=2 returned with lock == true
//!   1  any PCR returned lock == false, or the NSM returned an error / unexpected response
//!
//! Output (stderr): one line per PCR with index, lock, data length, and prefix.

use std::process::ExitCode;

use aws_nitro_enclaves_nsm_api::api::{Request, Response};
use aws_nitro_enclaves_nsm_api::driver::{nsm_exit, nsm_init, nsm_process_request};

fn main() -> ExitCode {
    let fd = nsm_init();
    if fd < 0 {
        eprintln!("nsm-describe-pcrs: nsm_init failed (fd={fd})");
        return ExitCode::FAILURE;
    }

    let mut all_locked = true;
    for index in 0u16..=2 {
        let response = nsm_process_request(fd, Request::DescribePCR { index });
        match response {
            Response::DescribePCR { lock, data } => {
                let prefix: String = data.iter().take(8).map(|b| format!("{b:02x}")).collect();
                eprintln!(
                    "nsm-describe-pcrs: PCR{index} lock={lock} data_len={} prefix={prefix}",
                    data.len()
                );
                if !lock {
                    all_locked = false;
                }
            }
            Response::Error(code) => {
                eprintln!("nsm-describe-pcrs: PCR{index} NSM error: {code:?}");
                all_locked = false;
            }
            other => {
                eprintln!("nsm-describe-pcrs: PCR{index} unexpected response: {other:?}");
                all_locked = false;
            }
        }
    }

    nsm_exit(fd);

    if all_locked { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}
