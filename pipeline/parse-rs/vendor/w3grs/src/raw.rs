//! Raw replay parser port.

use std::thread;

use flate2::{Decompress, FlushDecompress, Status};
use serde::{Deserialize, Serialize};

use crate::{
    buffer::StatefulBufferParser,
    error::{Error, Result},
};

const REPLAY_MAGIC: &[u8] = b"Warcraft III recorded game";
const FULL_DECOMPRESSED_BLOCK_SIZE: u16 = 8192;
const PARALLEL_DECOMPRESS_MIN_BLOCKS: usize = 192;
const PARALLEL_DECOMPRESS_MIN_BLOCKS_PER_WORKER: usize = 64;
const PARALLEL_DECOMPRESS_MIN_BYTES: usize = 1 << 20;
const PARALLEL_DECOMPRESS_MAX_WORKERS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub compressed_size: u32,
    pub header_version: String,
    pub decompressed_size: u32,
    pub compressed_data_block_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubHeader {
    pub game_identifier: String,
    pub version: u32,
    pub build_no: u16,
    pub replay_length_ms: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataBlock {
    pub block_size: u16,
    pub block_decompressed_size: u16,
    pub block_content: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BorrowedDataBlock<'a> {
    pub block_size: u16,
    pub block_decompressed_size: u16,
    pub block_content: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawReplayData {
    pub header: Header,
    pub subheader: SubHeader,
    pub blocks: Vec<DataBlock>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BorrowedRawReplayData<'a> {
    pub header: Header,
    pub subheader: SubHeader,
    pub blocks: Vec<BorrowedDataBlock<'a>>,
}

#[derive(Debug, Default)]
pub struct RawParser;

impl RawParser {
    pub fn new() -> Self {
        Self
    }

    pub fn parse(&self, input: &[u8]) -> Result<RawReplayData> {
        let mut parser = StatefulBufferParser::new(input);
        let header = parse_header(&mut parser)?;
        let subheader = parse_subheader(&mut parser)?;
        let blocks = parse_blocks(&mut parser, subheader.build_no)?;

        Ok(RawReplayData {
            header,
            subheader,
            blocks,
        })
    }

    pub(crate) fn parse_borrowed<'a>(&self, input: &'a [u8]) -> Result<BorrowedRawReplayData<'a>> {
        let mut parser = StatefulBufferParser::new(input);
        let header = parse_header(&mut parser)?;
        let subheader = parse_subheader(&mut parser)?;
        let blocks = parse_blocks_borrowed(&mut parser, subheader.build_no)?;

        Ok(BorrowedRawReplayData {
            header,
            subheader,
            blocks,
        })
    }
}

pub fn get_uncompressed_data(blocks: &[DataBlock]) -> Result<Vec<u8>> {
    get_uncompressed_blocks(blocks)
}

pub(crate) fn get_uncompressed_borrowed_data(blocks: &[BorrowedDataBlock<'_>]) -> Result<Vec<u8>> {
    get_uncompressed_blocks(blocks)
}

trait CompressedBlock: Sync {
    fn decompressed_size(&self) -> usize;
    fn content(&self) -> &[u8];
}

impl CompressedBlock for DataBlock {
    fn decompressed_size(&self) -> usize {
        self.block_decompressed_size as usize
    }

    fn content(&self) -> &[u8] {
        &self.block_content
    }
}

impl CompressedBlock for BorrowedDataBlock<'_> {
    fn decompressed_size(&self) -> usize {
        self.block_decompressed_size as usize
    }

    fn content(&self) -> &[u8] {
        self.block_content
    }
}

fn get_uncompressed_blocks<B>(blocks: &[B]) -> Result<Vec<u8>>
where
    B: CompressedBlock,
{
    let capacity = blocks.iter().map(CompressedBlock::decompressed_size).sum();
    let worker_count = parallel_decompress_worker_count(blocks.len(), capacity);
    if worker_count > 1 {
        return get_uncompressed_data_parallel(blocks, capacity, worker_count);
    }

    get_uncompressed_data_sequential(blocks, capacity)
}

fn get_uncompressed_data_sequential<B>(blocks: &[B], capacity: usize) -> Result<Vec<u8>>
where
    B: CompressedBlock,
{
    let mut out = vec![0; capacity];
    decode_blocks_to_slice(blocks, &mut out)?;
    Ok(out)
}

fn get_uncompressed_data_parallel<B>(
    blocks: &[B],
    capacity: usize,
    worker_count: usize,
) -> Result<Vec<u8>>
where
    B: CompressedBlock,
{
    let chunk_size = blocks.len().div_ceil(worker_count);
    let mut out = vec![0; capacity];

    thread::scope(|scope| {
        let mut handles = Vec::with_capacity(worker_count);
        let mut remaining_out = out.as_mut_slice();
        for chunk in blocks.chunks(chunk_size) {
            let capacity = chunk.iter().map(CompressedBlock::decompressed_size).sum();
            let (chunk_out, next_out) = remaining_out.split_at_mut(capacity);
            remaining_out = next_out;

            handles.push(scope.spawn(move || decode_blocks_to_slice(chunk, chunk_out)));
        }

        for handle in handles {
            handle
                .join()
                .map_err(|_| Error::Message("decompression worker panicked".to_string()))??;
        }

        Ok::<_, Error>(())
    })?;

    Ok(out)
}

fn decode_blocks_to_slice<B>(blocks: &[B], out: &mut [u8]) -> Result<()>
where
    B: CompressedBlock,
{
    let mut offset: usize = 0;
    let mut decompressor = Decompress::new(true);
    for block in blocks {
        let expected = block.decompressed_size();
        let content = block.content();
        if content.is_empty() {
            if expected == 0 {
                continue;
            }
            return Err(Error::Message(
                "compressed block content is empty but declares output".to_string(),
            ));
        }

        let end = offset
            .checked_add(expected)
            .ok_or_else(|| Error::Message("decompressed block offset overflow".to_string()))?;
        let Some(output) = out.get_mut(offset..end) else {
            return Err(Error::UnexpectedEof {
                offset,
                needed: expected,
            });
        };

        decode_block_to_slice(&mut decompressor, content, output, offset)?;

        offset = end;
    }

    if offset != out.len() {
        return Err(Error::UnexpectedEof {
            offset,
            needed: out.len().saturating_sub(offset),
        });
    }

    Ok(())
}

fn decode_block_to_slice(
    decompressor: &mut Decompress,
    content: &[u8],
    output: &mut [u8],
    output_offset: usize,
) -> Result<()> {
    decompressor.reset(true);
    let status = decompressor
        .decompress(content, output, FlushDecompress::Finish)
        .map_err(|error| Error::Message(format!("zlib decompression failed: {error}")))?;
    let written = decompressor.total_out() as usize;

    if status == Status::StreamEnd && written == output.len() {
        return Ok(());
    }

    if written < output.len() {
        return Err(Error::UnexpectedEof {
            offset: output_offset + written,
            needed: output.len() - written,
        });
    }

    let consumed = decompressor.total_in() as usize;
    let remaining = content.get(consumed..).unwrap_or_default();
    let mut extra = [0; 1];
    let status = decompressor
        .decompress(remaining, &mut extra, FlushDecompress::Finish)
        .map_err(|error| Error::Message(format!("zlib decompression failed: {error}")))?;
    let total_in = decompressor.total_in() as usize;
    let total_out = decompressor.total_out() as usize;
    // zlib-rs may report BufError when an exact-sized output buffer leaves no
    // room for the final status transition. The scratch read above still
    // catches any extra decompressed byte.
    if (status == Status::StreamEnd || total_in == content.len()) && total_out == output.len() {
        return Ok(());
    }

    Err(Error::Message(
        "decompressed block exceeded declared size".to_string(),
    ))
}

fn parallel_decompress_worker_count(blocks: usize, capacity: usize) -> usize {
    if blocks < PARALLEL_DECOMPRESS_MIN_BLOCKS || capacity < PARALLEL_DECOMPRESS_MIN_BYTES {
        return 1;
    }

    let available = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .min(PARALLEL_DECOMPRESS_MAX_WORKERS);
    available
        .min(blocks / PARALLEL_DECOMPRESS_MIN_BLOCKS_PER_WORKER)
        .max(1)
}

fn parse_header(parser: &mut StatefulBufferParser<'_>) -> Result<Header> {
    let offset = find_parse_start_offset(parser.buffer()).ok_or(Error::HeaderNotFound)?;
    parser.set_offset(offset);
    let _magic = parser.read_zero_term_string()?;
    parser.skip(4)?;
    let compressed_size = parser.read_u32_le()?;
    let header_version = parser.read_hex_string(4)?;
    let decompressed_size = parser.read_u32_le()?;
    let compressed_data_block_count = parser.read_u32_le()?;

    Ok(Header {
        compressed_size,
        header_version,
        decompressed_size,
        compressed_data_block_count,
    })
}

fn parse_subheader(parser: &mut StatefulBufferParser<'_>) -> Result<SubHeader> {
    let game_identifier = parser.read_string(4)?;
    let version = parser.read_u32_le()?;
    let build_no = parser.read_u16_le()?;
    parser.skip(2)?;
    let replay_length_ms = parser.read_u32_le()?;
    parser.skip(4)?;

    Ok(SubHeader {
        game_identifier,
        version,
        build_no,
        replay_length_ms,
    })
}

fn parse_blocks(parser: &mut StatefulBufferParser<'_>, build_no: u16) -> Result<Vec<DataBlock>> {
    let mut blocks = Vec::new();

    while !parser.is_done() {
        let block = parse_block(parser, build_no)?;
        if block.block_decompressed_size == FULL_DECOMPRESSED_BLOCK_SIZE {
            blocks.push(block);
        }
    }

    Ok(blocks)
}

fn parse_blocks_borrowed<'a>(
    parser: &mut StatefulBufferParser<'a>,
    build_no: u16,
) -> Result<Vec<BorrowedDataBlock<'a>>> {
    let mut blocks = Vec::new();

    while !parser.is_done() {
        let block = parse_block_borrowed(parser, build_no)?;
        if block.block_decompressed_size == FULL_DECOMPRESSED_BLOCK_SIZE {
            blocks.push(block);
        }
    }

    Ok(blocks)
}

fn parse_block(parser: &mut StatefulBufferParser<'_>, build_no: u16) -> Result<DataBlock> {
    let is_reforged = build_no >= 6089;
    let block_size = parser.read_u16_le()?;

    if is_reforged {
        parser.skip(2)?;
    }

    let block_decompressed_size = parser.read_u16_le()?;
    parser.skip(if is_reforged { 6 } else { 4 })?;
    let start = parser.offset();
    let end = start
        .saturating_add(block_size as usize)
        .min(parser.buffer().len());
    let block_content = parser.buffer()[start..end].to_vec();
    parser.set_offset(start.saturating_add(block_size as usize));

    Ok(DataBlock {
        block_size,
        block_decompressed_size,
        block_content,
    })
}

fn parse_block_borrowed<'a>(
    parser: &mut StatefulBufferParser<'a>,
    build_no: u16,
) -> Result<BorrowedDataBlock<'a>> {
    let is_reforged = build_no >= 6089;
    let block_size = parser.read_u16_le()?;

    if is_reforged {
        parser.skip(2)?;
    }

    let block_decompressed_size = parser.read_u16_le()?;
    parser.skip(if is_reforged { 6 } else { 4 })?;
    let start = parser.offset();
    let end = start
        .saturating_add(block_size as usize)
        .min(parser.buffer().len());
    let block_content = &parser.buffer()[start..end];
    parser.set_offset(start.saturating_add(block_size as usize));

    Ok(BorrowedDataBlock {
        block_size,
        block_decompressed_size,
        block_content,
    })
}

fn find_parse_start_offset(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(REPLAY_MAGIC.len())
        .position(|window| window == REPLAY_MAGIC)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_reforged_raw_replay() {
        let bytes = include_bytes!("../fixtures/replays/132/reforged1.w3g");
        let raw = RawParser::new().parse(bytes).unwrap();

        assert_eq!(raw.subheader.game_identifier, "PX3W");
        assert_eq!(raw.subheader.version, 10032);
        assert_eq!(raw.subheader.build_no, 6091);
        assert!(!raw.blocks.is_empty());
        assert_eq!(
            raw.header.compressed_data_block_count as usize,
            raw.blocks.len()
        );

        let data = get_uncompressed_data(&raw.blocks).unwrap();
        assert!(!data.is_empty());
    }

    #[test]
    fn parses_classic_raw_replay() {
        let bytes = include_bytes!("../fixtures/replays/126/standard_126.w3g");
        let raw = RawParser::new().parse(bytes).unwrap();

        assert_eq!(raw.subheader.game_identifier, "PX3W");
        assert_eq!(raw.subheader.version, 26);
        assert_eq!(raw.subheader.build_no, 6059);
        assert!(!raw.blocks.is_empty());
    }

    #[test]
    fn rejects_truncated_raw_block_header() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"Warcraft III recorded game\0");
        bytes.extend_from_slice(&[0; 4]);
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&[0; 4]);
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(b"PX3W");
        bytes.extend_from_slice(&10032u32.to_le_bytes());
        bytes.extend_from_slice(&6091u16.to_le_bytes());
        bytes.extend_from_slice(&[0; 2]);
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&[0; 4]);
        bytes.push(0x01);

        assert!(matches!(
            RawParser::new().parse(&bytes),
            Err(Error::UnexpectedEof { .. })
        ));
    }
}
