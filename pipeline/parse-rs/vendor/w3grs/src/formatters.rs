//! Formatting helpers ported from `w3gjs/src/parsers/formatters.ts`.

use crate::types::{ItemId, Race};

pub fn object_id_formatter(arr: [u8; 4]) -> ItemId {
    if arr[3] >= 0x41 && arr[3] <= 0x7a {
        ItemId::StringEncoded(arr.iter().rev().map(|byte| *byte as char).collect())
    } else {
        ItemId::Alphanumeric(arr.to_vec())
    }
}

pub fn race_flag_formatter(flag: u8) -> Race {
    match flag {
        0x01 | 0x41 => Race::Human,
        0x02 | 0x42 => Race::Orc,
        0x04 | 0x44 => Race::NightElf,
        0x08 | 0x48 => Race::Undead,
        0x20 | 0x60 => Race::Random,
        _ => Race::Random,
    }
}

pub fn chat_mode_formatter(flag: u32) -> String {
    match flag {
        0x00 => "ALL".to_string(),
        0x01 => "ALLY".to_string(),
        0x02 => "OBS".to_string(),
        3..=27 => format!("PRIVATE{flag}"),
        _ => "UNKNOWN".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_chat_modes() {
        assert_eq!(chat_mode_formatter(0), "ALL");
        assert_eq!(chat_mode_formatter(1), "ALLY");
        assert_eq!(chat_mode_formatter(2), "OBS");
        assert_eq!(chat_mode_formatter(3), "PRIVATE3");
        assert_eq!(chat_mode_formatter(27), "PRIVATE27");
    }

    #[test]
    fn formats_object_ids() {
        assert_eq!(
            object_id_formatter(*b"trah"),
            ItemId::StringEncoded("hart".to_string())
        );
        assert_eq!(
            object_id_formatter([0x03, 0x00, 0x00, 0x00]),
            ItemId::Alphanumeric(vec![0x03, 0, 0, 0])
        );
    }
}
