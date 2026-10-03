//! Length-prefixed JSON framing (contracts §10.1): 4-byte big-endian length + UTF-8 JSON.
use std::io::{self, Read, Write};

pub const MAX_FRAME: u32 = 8 * 1024 * 1024;

#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    TooLarge(u32),
}

impl From<io::Error> for FrameError {
    fn from(e: io::Error) -> Self {
        FrameError::Io(e)
    }
}

/// Returns Ok(None) on clean EOF before a frame header.
pub fn read_frame<R: Read>(r: &mut R) -> Result<Option<Vec<u8>>, FrameError> {
    let mut hdr = [0u8; 4];
    match r.read_exact(&mut hdr) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let len = u32::from_be_bytes(hdr);
    // Reject before allocating.
    if len > MAX_FRAME {
        return Err(FrameError::TooLarge(len));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

pub fn write_frame<W: Write>(w: &mut W, payload: &[u8]) -> Result<(), FrameError> {
    if payload.len() as u64 > MAX_FRAME as u64 {
        return Err(FrameError::TooLarge(payload.len() as u32));
    }
    w.write_all(&(payload.len() as u32).to_be_bytes())?;
    w.write_all(payload)?;
    w.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, b"{\"a\":1}").unwrap();
        let got = read_frame(&mut &buf[..]).unwrap().unwrap();
        assert_eq!(got, b"{\"a\":1}");
    }

    #[test]
    fn rejects_oversize_before_allocating() {
        let hdr = (MAX_FRAME + 1).to_be_bytes();
        match read_frame(&mut &hdr[..]) {
            Err(FrameError::TooLarge(n)) => assert_eq!(n, MAX_FRAME + 1),
            other => panic!("unexpected {:?}", other.map(|o| o.map(|v| v.len()))),
        }
    }

    #[test]
    fn eof_is_none() {
        assert!(read_frame(&mut &[][..]).unwrap().is_none());
    }
}
