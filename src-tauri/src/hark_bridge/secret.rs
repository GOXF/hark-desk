//! 敏感设置（ngrok authtoken、ngrok 固定域名）的本机加密存储。
//!
//! Windows 用 DPAPI（CryptProtectData，绑定当前用户），存成 `dp:<base64>`；
//! 其他平台没有 DPAPI，按需求明文回退，存成 `raw:<原文>`。
//! 没有前缀的值当作明文（兼容手改的配置）。解密失败返回 Err，调用方按「未设置」处理。

use base64::Engine;

const DP_PREFIX: &str = "dp:";
const RAW_PREFIX: &str = "raw:";

/// 加密一个值；空串原样返回空串。
pub fn encrypt(plain: &str) -> String {
    if plain.is_empty() {
        return String::new();
    }
    #[cfg(windows)]
    {
        match dpapi::protect(plain.as_bytes()) {
            Ok(bytes) => {
                return format!(
                    "{DP_PREFIX}{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                );
            }
            Err(error) => {
                // DPAPI 失败极少见（例如用户配置文件损坏）；不打印原文，只记错误码。
                tracing::warn!(%error, "DPAPI 加密失败，改为明文存储");
            }
        }
    }
    format!("{RAW_PREFIX}{plain}")
}

/// 解密 [`encrypt`] 存下的值。
pub fn decrypt(stored: &str) -> Result<String, String> {
    if stored.is_empty() {
        return Ok(String::new());
    }
    if let Some(b64) = stored.strip_prefix(DP_PREFIX) {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|e| format!("密文格式错误：{e}"))?;
        #[cfg(windows)]
        {
            let plain = dpapi::unprotect(&bytes)?;
            return String::from_utf8(plain).map_err(|_| "解密结果不是 UTF-8".to_string());
        }
        #[cfg(not(windows))]
        {
            let _ = bytes;
            return Err("这个值是在 Windows 上用 DPAPI 加密的，本平台无法解密".to_string());
        }
    }
    if let Some(plain) = stored.strip_prefix(RAW_PREFIX) {
        return Ok(plain.to_string());
    }
    Ok(stored.to_string())
}

#[cfg(windows)]
mod dpapi {
    //! 直接声明 crypt32 的两个函数，不依赖 windows crate 的 feature 开关。
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    #[link(name = "crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *const c_void,
            p_prompt_struct: *const c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *const c_void,
            p_prompt_struct: *const c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
        fn GetLastError() -> u32;
    }

    fn run(input: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
        let mut buf = input.to_vec();
        let data_in = DataBlob {
            cb_data: buf.len() as u32,
            pb_data: buf.as_mut_ptr(),
        };
        let mut data_out = DataBlob {
            cb_data: 0,
            pb_data: null_mut(),
        };
        // SAFETY：输入缓冲在调用期间有效；输出由系统用 LocalAlloc 分配，复制后用 LocalFree 释放。
        let ok = unsafe {
            if encrypt {
                CryptProtectData(
                    &data_in,
                    null(),
                    null(),
                    null(),
                    null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut data_out,
                )
            } else {
                CryptUnprotectData(
                    &data_in,
                    null_mut(),
                    null(),
                    null(),
                    null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut data_out,
                )
            }
        };
        if ok == 0 {
            let code = unsafe { GetLastError() };
            return Err(format!("DPAPI 调用失败（错误码 {code}）"));
        }
        let out = if data_out.pb_data.is_null() || data_out.cb_data == 0 {
            Vec::new()
        } else {
            // SAFETY：系统保证 pb_data 指向 cb_data 字节。
            unsafe { std::slice::from_raw_parts(data_out.pb_data, data_out.cb_data as usize) }
                .to_vec()
        };
        if !data_out.pb_data.is_null() {
            unsafe {
                LocalFree(data_out.pb_data as *mut c_void);
            }
        }
        Ok(out)
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        run(plain, true)
    }

    pub fn unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
        run(cipher, false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        assert_eq!(encrypt(""), "");
        let enc = encrypt("2abc_secret");
        assert_ne!(enc, "2abc_secret");
        assert_eq!(decrypt(&enc).unwrap(), "2abc_secret");
        assert_eq!(decrypt("plain").unwrap(), "plain");
        assert_eq!(decrypt("raw:x").unwrap(), "x");
    }
}
