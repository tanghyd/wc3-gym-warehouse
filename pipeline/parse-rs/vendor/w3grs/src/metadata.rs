//! Replay metadata parser port.

use prost::Message;
use serde::{Deserialize, Serialize};

use crate::{
    buffer::StatefulBufferParser,
    error::Result,
    raw::{DataBlock, get_uncompressed_data},
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayMetadata {
    pub game_data: Vec<u8>,
    pub map: MapMetadata,
    pub player_count: u32,
    pub game_type: String,
    pub locale_hash: String,
    pub player_records: Vec<PlayerRecord>,
    pub slot_records: Vec<SlotRecord>,
    pub reforged_player_metadata: Vec<ReforgedPlayerMetadata>,
    pub random_seed: u32,
    pub select_mode: String,
    pub game_name: String,
    pub start_spot_count: u8,
    pub is_post_202_replay_format: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerRecord {
    pub player_id: u8,
    pub player_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotRecord {
    pub player_id: u8,
    pub download_progress: u8,
    pub slot_status: u8,
    pub computer_flag: u8,
    pub team_id: u8,
    pub color: u8,
    pub race_flag: u8,
    pub ai_strength: u8,
    pub handicap_flag: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReforgedPlayerMetadata {
    pub player_id: u32,
    pub name: String,
    pub clan: String,
    pub skins: Vec<SkinData>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinData {
    pub unit_id: u32,
    pub skin_id: u32,
    pub skin_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapMetadata {
    pub speed: u8,
    pub hide_terrain: bool,
    pub map_explored: bool,
    pub always_visible: bool,
    pub default: bool,
    pub observer_mode: u8,
    pub teams_together: bool,
    pub fixed_teams: bool,
    pub full_shared_unit_control: bool,
    pub random_hero: bool,
    pub random_races: bool,
    pub referees: bool,
    pub map_checksum: String,
    pub map_checksum_sha1: String,
    pub map_name: String,
    pub creator: String,
}

#[derive(Debug, Default)]
pub struct MetadataParser;

impl MetadataParser {
    pub fn new() -> Self {
        Self
    }

    pub fn parse(&self, blocks: &[DataBlock]) -> Result<ReplayMetadata> {
        self.parse_data(&get_uncompressed_data(blocks)?)
    }

    pub fn parse_data(&self, data: &[u8]) -> Result<ReplayMetadata> {
        Ok(self.parse_data_parts(data, true)?.metadata)
    }

    pub(crate) fn parse_data_without_game_data(&self, data: &[u8]) -> Result<ReplayMetadataParts> {
        self.parse_data_parts(data, false)
    }

    fn parse_data_parts(
        &self,
        data: &[u8],
        include_game_data: bool,
    ) -> Result<ReplayMetadataParts> {
        let mut parser = StatefulBufferParser::new(data);
        let mut is_post_202_replay_format = false;

        parser.skip(5)?;
        let mut player_records = vec![parse_host_record(&mut parser)?];
        let game_name = parser.read_zero_term_string()?;
        let _private_string = parser.read_zero_term_string()?;
        let encoded_string = read_zero_term_hex_string(&mut parser)?;
        let map = parse_encoded_map_meta_string(&decode_game_meta_string(&encoded_string)?)?;
        let player_count = parser.read_u32_le()?;
        let game_type = parser.read_hex_string(4)?;
        let locale_hash = parser.read_hex_string(4)?;

        let mut player_records_final = Vec::new();
        player_records_final.extend(player_records.clone());
        player_records_final.extend(player_records.clone());
        player_records_final.extend(parse_player_list(&mut parser)?);
        player_records = player_records_final;

        let mut reforged_player_metadata = Vec::new();
        if parser.peek_u8()? != 25 {
            reforged_player_metadata =
                parse_reforged_player_metadata(&mut parser, &mut is_post_202_replay_format)?;
        }

        let marker = parser.read_u8()?;
        if marker != 25 {
            return Err(crate::error::Error::Message(format!(
                "unknown metadata chunk marker: {marker:#04x}"
            )));
        }

        let _remaining_bytes = parser.read_u16_le()?;
        let slot_record_count = parser.read_u8()?;
        let slot_records = parse_slot_records(&mut parser, slot_record_count)?;
        let random_seed = parser.read_u32_le()?;
        let select_mode = parser.read_hex_string(1)?;
        let start_spot_count = parser.read_u8()?;
        let game_data_offset = parser.offset();
        let game_data = if include_game_data {
            parser.buffer()[game_data_offset..].to_vec()
        } else {
            Vec::new()
        };

        Ok(ReplayMetadataParts {
            metadata: ReplayMetadata {
                game_data,
                map,
                player_count,
                game_type,
                locale_hash,
                player_records,
                slot_records,
                reforged_player_metadata,
                random_seed,
                select_mode,
                game_name,
                start_spot_count,
                is_post_202_replay_format,
            },
            game_data_offset,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ReplayMetadataParts {
    pub metadata: ReplayMetadata,
    pub game_data_offset: usize,
}

fn parse_slot_records(parser: &mut StatefulBufferParser<'_>, count: u8) -> Result<Vec<SlotRecord>> {
    let mut slots = Vec::with_capacity(count as usize);
    for _ in 0..count {
        slots.push(SlotRecord {
            player_id: parser.read_u8()?,
            download_progress: parser.read_u8()?,
            slot_status: parser.read_u8()?,
            computer_flag: parser.read_u8()?,
            team_id: parser.read_u8()?,
            color: parser.read_u8()?,
            race_flag: parser.read_u8()?,
            ai_strength: parser.read_u8()?,
            handicap_flag: parser.read_u8()?,
        });
    }
    Ok(slots)
}

fn parse_reforged_player_metadata(
    parser: &mut StatefulBufferParser<'_>,
    is_post_202_replay_format: &mut bool,
) -> Result<Vec<ReforgedPlayerMetadata>> {
    let mut result = Vec::new();
    let mut skin_sets: Vec<(u32, Vec<SkinData>)> = Vec::new();

    while matches!(parser.peek_u8()?, 0x38 | 0x39) {
        if parser.read_u8()? == 0x38 {
            *is_post_202_replay_format = true;
        }

        let subtype = parser.read_u8()?;
        let following_bytes = parser.read_u32_le()? as usize;
        let data = parser.read_bytes(following_bytes)?;

        match subtype {
            0x03 => {
                let players = decode_reforged_players(data)?;
                result.extend(players.into_iter().map(|decoded| ReforgedPlayerMetadata {
                    player_id: decoded.player_id,
                    name: decoded.battle_tag,
                    clan: decoded.clan,
                    skins: Vec::new(),
                }));
            }
            0x04 => {
                let decoded = ProtoReforgedSkinData::decode(data)?;
                skin_sets.push((
                    decoded.player_id,
                    decoded
                        .skins
                        .into_iter()
                        .map(|skin| SkinData {
                            unit_id: skin.unit_id,
                            skin_id: skin.skin_id,
                            skin_name: skin.skin_name,
                        })
                        .collect(),
                ));
            }
            _ => {}
        }
    }

    for player in &mut result {
        if let Some((_, skins)) = skin_sets
            .iter()
            .find(|(player_id, _)| *player_id == player.player_id)
        {
            player.skins = skins.clone();
        }
    }

    Ok(result)
}

fn decode_reforged_players(data: &[u8]) -> Result<Vec<ProtoReforgedPlayerData>> {
    match ProtoReforgedPlayerData::decode(data) {
        Ok(player) => Ok(vec![player]),
        Err(_) => {
            let decoded = ProtoReforgedPlayerDataList::decode(data)?;
            Ok(decoded.players.into_iter().last().into_iter().collect())
        }
    }
}

fn parse_encoded_map_meta_string(buffer: &[u8]) -> Result<MapMetadata> {
    let mut parser = StatefulBufferParser::new(buffer);

    let speed = parser.read_u8()?;
    let second_byte = parser.read_u8()?;
    let third_byte = parser.read_u8()?;
    let fourth_byte = parser.read_u8()?;
    parser.skip(5)?;
    let map_checksum = parser.read_hex_string(4)?;
    let map_name = parser.read_zero_term_string()?;
    let creator = parser.read_zero_term_string()?;
    parser.skip(1)?;
    let map_checksum_sha1 = parser.read_hex_string(20)?;

    Ok(MapMetadata {
        speed,
        hide_terrain: second_byte & 0b0000_0001 != 0,
        map_explored: second_byte & 0b0000_0010 != 0,
        always_visible: second_byte & 0b0000_0100 != 0,
        default: second_byte & 0b0000_1000 != 0,
        observer_mode: (second_byte & 0b0011_0000) >> 4,
        teams_together: second_byte & 0b0100_0000 != 0,
        fixed_teams: third_byte & 0b0000_0110 != 0,
        full_shared_unit_control: fourth_byte & 0b0000_0001 != 0,
        random_hero: fourth_byte & 0b0000_0010 != 0,
        random_races: fourth_byte & 0b0000_0100 != 0,
        referees: fourth_byte & 0b0100_0000 != 0,
        map_checksum,
        map_checksum_sha1,
        map_name,
        creator,
    })
}

fn parse_player_list(parser: &mut StatefulBufferParser<'_>) -> Result<Vec<PlayerRecord>> {
    let mut list = Vec::new();
    while parser.read_u8()? == 22 {
        list.push(parse_host_record(parser)?);
        parser.skip(4)?;
    }
    parser.skip(-1)?;
    Ok(list)
}

fn parse_host_record(parser: &mut StatefulBufferParser<'_>) -> Result<PlayerRecord> {
    let player_id = parser.read_u8()?;
    let player_name = parser.read_zero_term_string()?;
    let add_data = parser.read_u8()?;
    parser.skip(add_data as isize)?;
    Ok(PlayerRecord {
        player_id,
        player_name,
    })
}

fn read_zero_term_hex_string(parser: &mut StatefulBufferParser<'_>) -> Result<String> {
    let start = parser.offset();
    while parser.peek_u8()? != 0 {
        parser.skip(1)?;
    }
    let end = parser.offset();
    parser.skip(1)?;
    Ok(crate::buffer::to_hex(&parser.buffer()[start..end]))
}

fn decode_game_meta_string(str_hex: &str) -> Result<Vec<u8>> {
    let hex_representation = decode_hex(str_hex)?;
    let mut decoded = Vec::with_capacity(hex_representation.len());
    let mut mask = 0;

    for (i, byte) in hex_representation.into_iter().enumerate() {
        if i % 8 == 0 {
            mask = byte;
        } else if (mask & (0x1 << (i % 8))) == 0 {
            decoded.push(byte.wrapping_sub(1));
        } else {
            decoded.push(byte);
        }
    }

    Ok(decoded)
}

fn decode_hex(input: &str) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() / 2);
    let bytes = input.as_bytes();
    for pair in bytes.chunks_exact(2) {
        let hi = hex_value(pair[0])?;
        let lo = hex_value(pair[1])?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn hex_value(byte: u8) -> Result<u8> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(crate::error::Error::Message(format!(
            "invalid hex byte: {byte:#04x}"
        ))),
    }
}

#[derive(Clone, PartialEq, Message)]
struct ProtoReforgedPlayerData {
    #[prost(uint32, tag = "1")]
    player_id: u32,
    #[prost(string, tag = "2")]
    battle_tag: String,
    #[prost(string, tag = "3")]
    clan: String,
    #[prost(string, tag = "4")]
    portrait: String,
    #[prost(uint32, tag = "5")]
    team: u32,
    #[prost(string, tag = "6")]
    unknown: String,
}

#[derive(Clone, PartialEq, Message)]
struct ProtoReforgedPlayerDataList {
    #[prost(message, repeated, tag = "1")]
    players: Vec<ProtoReforgedPlayerData>,
}

#[derive(Clone, PartialEq, Message)]
struct ProtoSkinData {
    #[prost(uint32, tag = "1")]
    unit_id: u32,
    #[prost(uint32, tag = "2")]
    skin_id: u32,
    #[prost(string, tag = "3")]
    skin_name: String,
}

#[derive(Clone, PartialEq, Message)]
struct ProtoReforgedSkinData {
    #[prost(uint32, tag = "1")]
    player_id: u32,
    #[prost(message, repeated, tag = "2")]
    skins: Vec<ProtoSkinData>,
}

#[cfg(test)]
mod tests {
    use crate::raw::RawParser;

    use super::*;

    #[test]
    fn parses_reforged_metadata() {
        let bytes = include_bytes!("../fixtures/replays/132/reforged1.w3g");
        let raw = RawParser::new().parse(bytes).unwrap();
        let metadata = MetadataParser::new().parse(&raw.blocks).unwrap();

        assert_eq!(metadata.game_name, "BNet");
        assert!(metadata.player_count >= 2);
        assert!(metadata.slot_records.len() >= 2);
        assert!(!metadata.game_data.is_empty());
    }

    #[test]
    fn parses_reforged_player_metadata_chunks() {
        let bytes = include_bytes!("../fixtures/replays/132/reforged_truncated_playernames.w3g");
        let raw = RawParser::new().parse(bytes).unwrap();
        let metadata = MetadataParser::new().parse(&raw.blocks).unwrap();

        assert_eq!(metadata.reforged_player_metadata.len(), 1);
        assert_eq!(
            metadata.reforged_player_metadata[0].name,
            "\u{420}\u{43e}\u{437}\u{43e}\u{432}\u{44b}\u{439}\u{41f}\u{43e}\u{43d}\u{438}#228941"
        );
    }

    #[test]
    fn parses_classic_metadata() {
        let bytes = include_bytes!("../fixtures/replays/126/standard_126.w3g");
        let raw = RawParser::new().parse(bytes).unwrap();
        let metadata = MetadataParser::new().parse(&raw.blocks).unwrap();

        assert!(metadata.player_count > 0);
        assert!(!metadata.slot_records.is_empty());
        assert!(!metadata.map.map_name.is_empty());
    }
}
