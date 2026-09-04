use std::string::FromUtf8Error;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not find Warcraft III replay header")]
    HeaderNotFound,
    #[error("unexpected end of buffer while reading {needed} bytes at offset {offset}")]
    UnexpectedEof { offset: usize, needed: usize },
    #[error("invalid UTF-8 in replay string")]
    Utf8(#[from] FromUtf8Error),
    #[error("I/O error")]
    Io(#[from] std::io::Error),
    #[error("protobuf decode failed")]
    Protobuf(#[from] prost::DecodeError),
    #[error("replay parser instances cannot parse concurrently")]
    ConcurrentParsingNotSupported,
    #[error("parser error: {0}")]
    Message(String),
}

pub type Result<T> = std::result::Result<T, Error>;
