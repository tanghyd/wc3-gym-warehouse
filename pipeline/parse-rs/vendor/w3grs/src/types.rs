use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Race {
    #[serde(rename = "H")]
    Human,
    #[serde(rename = "N")]
    NightElf,
    #[serde(rename = "O")]
    Orc,
    #[serde(rename = "U")]
    Undead,
    #[serde(rename = "R")]
    Random,
}

impl Race {
    pub fn as_w3gjs_code(self) -> &'static str {
        match self {
            Race::Human => "H",
            Race::NightElf => "N",
            Race::Orc => "O",
            Race::Undead => "U",
            Race::Random => "R",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value")]
pub enum ItemId {
    #[serde(rename = "alphanumeric")]
    Alphanumeric(Vec<u8>),
    #[serde(rename = "stringencoded")]
    StringEncoded(String),
}
