use crate::error::{Error, Result};

#[derive(Debug, Clone)]
pub struct StatefulBufferParser<'a> {
    buffer: &'a [u8],
    offset: usize,
}

impl<'a> StatefulBufferParser<'a> {
    pub fn new(buffer: &'a [u8]) -> Self {
        Self { buffer, offset: 0 }
    }

    pub fn reset(&mut self, buffer: &'a [u8]) {
        self.buffer = buffer;
        self.offset = 0;
    }

    pub fn buffer(&self) -> &'a [u8] {
        self.buffer
    }

    pub fn offset(&self) -> usize {
        self.offset
    }

    pub fn set_offset(&mut self, offset: usize) {
        self.offset = offset;
    }

    pub fn skip(&mut self, byte_count: isize) -> Result<()> {
        if byte_count < 0 {
            let amount = byte_count.unsigned_abs();
            self.offset = self
                .offset
                .checked_sub(amount)
                .ok_or(Error::UnexpectedEof {
                    offset: self.offset,
                    needed: amount,
                })?;
            return Ok(());
        }

        self.ensure(byte_count as usize)?;
        self.offset += byte_count as usize;
        Ok(())
    }

    pub fn remaining(&self) -> usize {
        self.buffer.len().saturating_sub(self.offset)
    }

    pub fn is_done(&self) -> bool {
        self.offset >= self.buffer.len()
    }

    pub fn read_u8(&mut self) -> Result<u8> {
        self.ensure(1)?;
        let value = self.buffer[self.offset];
        self.offset += 1;
        Ok(value)
    }

    pub fn peek_u8(&self) -> Result<u8> {
        self.ensure(1)?;
        Ok(self.buffer[self.offset])
    }

    pub fn read_u16_le(&mut self) -> Result<u16> {
        let bytes = self.read_array::<2>()?;
        Ok(u16::from_le_bytes(bytes))
    }

    pub fn read_u32_le(&mut self) -> Result<u32> {
        let bytes = self.read_array::<4>()?;
        Ok(u32::from_le_bytes(bytes))
    }

    pub fn read_f32_le(&mut self) -> Result<f32> {
        let bytes = self.read_array::<4>()?;
        Ok(f32::from_le_bytes(bytes))
    }

    pub fn read_bytes(&mut self, length: usize) -> Result<&'a [u8]> {
        self.ensure(length)?;
        let start = self.offset;
        self.offset += length;
        Ok(&self.buffer[start..start + length])
    }

    pub fn read_string(&mut self, length: usize) -> Result<String> {
        Ok(String::from_utf8_lossy(self.read_bytes(length)?).to_string())
    }

    pub fn read_hex_string(&mut self, length: usize) -> Result<String> {
        Ok(to_hex(self.read_bytes(length)?))
    }

    pub fn read_zero_term_string(&mut self) -> Result<String> {
        let start = self.offset;
        while self.offset < self.buffer.len() && self.buffer[self.offset] != 0 {
            self.offset += 1;
        }
        self.ensure(1)?;
        let end = self.offset;
        self.offset += 1;
        Ok(String::from_utf8_lossy(&self.buffer[start..end]).to_string())
    }

    fn read_array<const N: usize>(&mut self) -> Result<[u8; N]> {
        self.ensure(N)?;
        let mut bytes = [0; N];
        bytes.copy_from_slice(&self.buffer[self.offset..self.offset + N]);
        self.offset += N;
        Ok(bytes)
    }

    fn ensure(&self, needed: usize) -> Result<()> {
        if self.offset + needed > self.buffer.len() {
            return Err(Error::UnexpectedEof {
                offset: self.offset,
                needed,
            });
        }
        Ok(())
    }
}

pub fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}
