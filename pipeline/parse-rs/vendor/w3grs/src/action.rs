//! Action parser port.

use crate::{
    buffer::StatefulBufferParser,
    error::{Error, Result},
};
use serde::{Deserialize, Serialize, Serializer, ser::SerializeMap};

pub type NetTag = [u32; 2];
pub type Vec2 = [f32; 2];
pub type FourCC = [u8; 4];

pub fn format_fourcc_or_hex(value: FourCC) -> String {
    if value[3].is_ascii_alphabetic() {
        value.iter().rev().map(|byte| *byte as char).collect()
    } else {
        format!(
            "0x{}",
            value
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        )
    }
}

pub fn format_net_tag(value: NetTag) -> String {
    format!("n:{}:{}", value[0], value[1])
}

pub fn format_optional_net_tag(value: NetTag) -> Option<String> {
    (value != [u32::MAX, u32::MAX]).then(|| format_net_tag(value))
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub enum Action {
    SetGameSpeed {
        game_speed: u8,
    },
    UnitBuildingAbilityNoParams {
        ability_flags: u16,
        order_id: FourCC,
    },
    UnitBuildingAbilityTargetPosition {
        ability_flags: u16,
        order_id: FourCC,
        target: Vec2,
    },
    UnitBuildingAbilityTargetPositionObject {
        ability_flags: u16,
        order_id: FourCC,
        target: Vec2,
        object: NetTag,
    },
    GiveItemToUnit {
        ability_flags: u16,
        order_id: FourCC,
        target: Vec2,
        unit: NetTag,
        item: NetTag,
    },
    UnitBuildingAbilityTwoTargetPositions {
        ability_flags: u16,
        order_id1: FourCC,
        target_a: Vec2,
        order_id2: FourCC,
        flags: u32,
        category: u32,
        owner: u8,
        target_b: Vec2,
    },
    UnitBuildingAbilityTargetPositionObjectItem {
        ability_flags: u16,
        order_id1: FourCC,
        target_a: Vec2,
        order_id2: FourCC,
        flags: u32,
        category: u32,
        owner: u8,
        target_b: Vec2,
        object: NetTag,
    },
    ChangeSelection {
        select_mode: u8,
        number_units: u16,
        units: Vec<NetTag>,
    },
    AssignGroupHotkey {
        group_number: u8,
        number_units: u16,
        units: Vec<NetTag>,
    },
    SelectGroupHotkey {
        group_number: u8,
    },
    SelectSubgroup {
        item_id: FourCC,
        object: NetTag,
    },
    PreSubselection,
    SelectUnit {
        object: NetTag,
    },
    SelectGroundItem {
        item: NetTag,
    },
    CancelHeroRevival {
        hero: NetTag,
    },
    RemoveUnitFromBuildingQueue {
        action_id: u8,
        slot_number: u8,
        item_id: FourCC,
    },
    TransferResources {
        slot: u8,
        gold: u32,
        lumber: u32,
    },
    EscPressed,
    TrackableHit {
        object: NetTag,
    },
    TrackableTrack {
        object: NetTag,
    },
    ChooseHeroSkillSubmenu,
    EnterBuildingSubmenu,
    AllyPing {
        pos: Vec2,
        duration: f32,
    },
    BlzCacheStoreInt {
        cache: Cache,
        value: u32,
    },
    BlzCacheStoreReal {
        cache: Cache,
        value: f32,
    },
    BlzCacheStoreBoolean {
        cache: Cache,
        value: u8,
    },
    BlzCacheStoreUnit {
        cache: Cache,
        value: Unit,
    },
    BlzCacheClearInt {
        cache: Cache,
    },
    BlzCacheClearReal {
        cache: Cache,
    },
    BlzCacheClearBoolean {
        cache: Cache,
    },
    BlzCacheClearUnit {
        cache: Cache,
    },
    ArrowKey {
        arrow_key: u8,
    },
    Mouse {
        event_id: u8,
        pos: Vec2,
        button: u8,
    },
    W3Api {
        command_id: u32,
        data: u32,
        buffer: String,
    },
    BlzSync {
        identifier: String,
        value: String,
    },
    CommandFrame {
        event_id: u32,
        val: f32,
        text: String,
    },
    #[cfg(feature = "extended-actions")]
    ChangeAllyOptions {
        slot: u8,
        flags: u32,
    },
    #[cfg(feature = "extended-actions")]
    MapTriggerChatCommand {
        unknown_a: u32,
        unknown_b: u32,
        command: String,
    },
    #[cfg(feature = "extended-actions")]
    ScenarioTrigger {
        unknown_a: u32,
        unknown_b: u32,
        counter: u32,
    },
    #[cfg(feature = "extended-actions")]
    ContinueGameBlockB {
        a: u32,
        b: u32,
        c: u32,
        d: u32,
    },
    #[cfg(feature = "extended-actions")]
    ContinueGameBlockA {
        a: u32,
        b: u32,
        c: u32,
        d: u32,
    },
    #[cfg(feature = "extended-actions")]
    CommandCardSource {
        source_unit_tag: NetTag,
        ability_id: FourCC,
        order_id: FourCC,
        raw_opcode: u8,
        normalized_opcode: u8,
    },
    #[cfg(feature = "extended-actions")]
    OpaqueDroppedAction {
        raw_opcode: u8,
        normalized_opcode: u8,
        payload: Vec<u8>,
    },
}

impl Action {
    pub fn id(&self) -> u8 {
        match self {
            Action::SetGameSpeed { .. } => 0x03,
            Action::UnitBuildingAbilityNoParams { .. } => 0x10,
            Action::UnitBuildingAbilityTargetPosition { .. } => 0x11,
            Action::UnitBuildingAbilityTargetPositionObject { .. } => 0x12,
            Action::GiveItemToUnit { .. } => 0x13,
            Action::UnitBuildingAbilityTwoTargetPositions { .. } => 0x14,
            Action::UnitBuildingAbilityTargetPositionObjectItem { .. } => 0x15,
            Action::ChangeSelection { .. } => 0x16,
            Action::AssignGroupHotkey { .. } => 0x17,
            Action::SelectGroupHotkey { .. } => 0x18,
            Action::SelectSubgroup { .. } => 0x19,
            Action::PreSubselection => 0x1a,
            Action::SelectUnit { .. } => 0x1b,
            Action::SelectGroundItem { .. } => 0x1c,
            Action::CancelHeroRevival { .. } => 0x1d,
            Action::RemoveUnitFromBuildingQueue { action_id, .. } => *action_id,
            Action::TransferResources { .. } => 0x51,
            Action::EscPressed => 0x61,
            Action::TrackableHit { .. } => 0x64,
            Action::TrackableTrack { .. } => 0x65,
            Action::ChooseHeroSkillSubmenu => 0x66,
            Action::EnterBuildingSubmenu => 0x67,
            Action::AllyPing { .. } => 0x68,
            Action::BlzCacheStoreInt { .. } => 0x6b,
            Action::BlzCacheStoreReal { .. } => 0x6c,
            Action::BlzCacheStoreBoolean { .. } => 0x6d,
            Action::BlzCacheStoreUnit { .. } => 0x6e,
            Action::BlzCacheClearInt { .. } => 0x70,
            Action::BlzCacheClearReal { .. } => 0x71,
            Action::BlzCacheClearBoolean { .. } => 0x72,
            Action::BlzCacheClearUnit { .. } => 0x73,
            Action::ArrowKey { .. } => 0x75,
            Action::Mouse { .. } => 0x76,
            Action::W3Api { .. } => 0x77,
            Action::BlzSync { .. } => 0x78,
            Action::CommandFrame { .. } => 0x79,
            #[cfg(feature = "extended-actions")]
            Action::ChangeAllyOptions { .. } => 0x50,
            #[cfg(feature = "extended-actions")]
            Action::MapTriggerChatCommand { .. } => 0x60,
            #[cfg(feature = "extended-actions")]
            Action::ScenarioTrigger { .. } => 0x62,
            #[cfg(feature = "extended-actions")]
            Action::ContinueGameBlockB { .. } => 0x69,
            #[cfg(feature = "extended-actions")]
            Action::ContinueGameBlockA { .. } => 0x6a,
            #[cfg(feature = "extended-actions")]
            Action::CommandCardSource {
                normalized_opcode, ..
            } => *normalized_opcode,
            #[cfg(feature = "extended-actions")]
            Action::OpaqueDroppedAction {
                normalized_opcode, ..
            } => *normalized_opcode,
        }
    }
}

pub(crate) trait SummaryActionVisitor {
    fn unit_building_ability_no_params(&mut self, order_id: FourCC) -> Result<()>;
    fn unit_building_ability_target_position(&mut self, order_id: FourCC) -> Result<()>;
    fn unit_building_ability_target_position_object(&mut self, order_id: FourCC) -> Result<()>;
    fn give_item_to_unit(&mut self) -> Result<()>;
    fn unit_building_ability_two_target_positions(&mut self, order_id1: FourCC) -> Result<()>;
    fn change_selection(&mut self, select_mode: u8) -> Result<()>;
    fn assign_group_hotkey(&mut self, group_number: u8) -> Result<()>;
    fn select_group_hotkey(&mut self, group_number: u8) -> Result<()>;
    fn select_ground_item(&mut self) -> Result<()>;
    fn cancel_hero_revival(&mut self) -> Result<()>;
    fn remove_unit_from_building_queue(&mut self) -> Result<()>;
    fn transfer_resources(&mut self, slot: u8, gold: u32, lumber: u32) -> Result<()>;
    fn esc_pressed(&mut self) -> Result<()>;
    fn choose_hero_skill_submenu(&mut self) -> Result<()>;
    fn enter_building_submenu(&mut self) -> Result<()>;
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct SummaryActionStats {
    pub actions: u64,
    pub emitted_actions: u64,
    pub ignored_actions: u64,
}

impl Serialize for Action {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("id", &self.id())?;

        match self {
            Action::SetGameSpeed { game_speed } => {
                map.serialize_entry("gameSpeed", game_speed)?;
            }
            Action::UnitBuildingAbilityNoParams {
                ability_flags,
                order_id,
            } => {
                map.serialize_entry("abilityFlags", ability_flags)?;
                map.serialize_entry("orderId", order_id)?;
            }
            Action::UnitBuildingAbilityTargetPosition {
                ability_flags,
                order_id,
                target,
            } => {
                map.serialize_entry("abilityFlags", ability_flags)?;
                map.serialize_entry("orderId", order_id)?;
                map.serialize_entry("target", target)?;
            }
            Action::UnitBuildingAbilityTargetPositionObject {
                ability_flags,
                order_id,
                target,
                object,
            } => {
                map.serialize_entry("abilityFlags", ability_flags)?;
                map.serialize_entry("orderId", order_id)?;
                map.serialize_entry("target", target)?;
                map.serialize_entry("object", object)?;
            }
            Action::GiveItemToUnit {
                ability_flags,
                order_id,
                target,
                unit,
                item,
            } => {
                map.serialize_entry("abilityFlags", ability_flags)?;
                map.serialize_entry("orderId", order_id)?;
                map.serialize_entry("target", target)?;
                map.serialize_entry("unit", unit)?;
                map.serialize_entry("item", item)?;
            }
            Action::UnitBuildingAbilityTwoTargetPositions {
                ability_flags,
                order_id1,
                target_a,
                order_id2,
                flags,
                category,
                owner,
                target_b,
            } => serialize_two_target_action(
                &mut map,
                TwoTargetActionFields {
                    ability_flags,
                    order_id1,
                    target_a,
                    order_id2,
                    flags,
                    category,
                    owner,
                    target_b,
                },
            )?,
            Action::UnitBuildingAbilityTargetPositionObjectItem {
                ability_flags,
                order_id1,
                target_a,
                order_id2,
                flags,
                category,
                owner,
                target_b,
                object,
            } => {
                serialize_two_target_action(
                    &mut map,
                    TwoTargetActionFields {
                        ability_flags,
                        order_id1,
                        target_a,
                        order_id2,
                        flags,
                        category,
                        owner,
                        target_b,
                    },
                )?;
                map.serialize_entry("object", object)?;
            }
            Action::ChangeSelection {
                select_mode,
                number_units,
                units,
            } => {
                map.serialize_entry("selectMode", select_mode)?;
                map.serialize_entry("numberUnits", number_units)?;
                map.serialize_entry("units", units)?;
            }
            Action::AssignGroupHotkey {
                group_number,
                number_units,
                units,
            } => {
                map.serialize_entry("groupNumber", group_number)?;
                map.serialize_entry("numberUnits", number_units)?;
                map.serialize_entry("units", units)?;
            }
            Action::SelectGroupHotkey { group_number } => {
                map.serialize_entry("groupNumber", group_number)?;
            }
            Action::SelectSubgroup { item_id, object } => {
                map.serialize_entry("itemId", item_id)?;
                map.serialize_entry("object", object)?;
            }
            Action::PreSubselection => {}
            Action::SelectUnit { object } => {
                map.serialize_entry("object", object)?;
            }
            Action::SelectGroundItem { item } => {
                map.serialize_entry("item", item)?;
            }
            Action::CancelHeroRevival { hero } => {
                map.serialize_entry("hero", hero)?;
            }
            Action::RemoveUnitFromBuildingQueue {
                slot_number,
                item_id,
                ..
            } => {
                map.serialize_entry("slotNumber", slot_number)?;
                map.serialize_entry("itemId", item_id)?;
            }
            Action::TransferResources { slot, gold, lumber } => {
                map.serialize_entry("slot", slot)?;
                map.serialize_entry("gold", gold)?;
                map.serialize_entry("lumber", lumber)?;
            }
            Action::EscPressed | Action::ChooseHeroSkillSubmenu | Action::EnterBuildingSubmenu => {}
            Action::TrackableHit { object } | Action::TrackableTrack { object } => {
                map.serialize_entry("object", object)?;
            }
            Action::AllyPing { pos, duration } => {
                map.serialize_entry("pos", pos)?;
                map.serialize_entry("duration", duration)?;
            }
            Action::BlzCacheStoreInt { cache, value } => {
                map.serialize_entry("cache", cache)?;
                map.serialize_entry("value", value)?;
            }
            Action::BlzCacheStoreReal { cache, value } => {
                map.serialize_entry("cache", cache)?;
                map.serialize_entry("value", value)?;
            }
            Action::BlzCacheStoreBoolean { cache, value } => {
                map.serialize_entry("cache", cache)?;
                map.serialize_entry("value", value)?;
            }
            Action::BlzCacheStoreUnit { cache, value } => {
                map.serialize_entry("cache", cache)?;
                map.serialize_entry("value", value)?;
            }
            Action::BlzCacheClearInt { cache }
            | Action::BlzCacheClearReal { cache }
            | Action::BlzCacheClearBoolean { cache }
            | Action::BlzCacheClearUnit { cache } => {
                map.serialize_entry("cache", cache)?;
            }
            Action::ArrowKey { arrow_key } => {
                map.serialize_entry("arrowKey", arrow_key)?;
            }
            Action::Mouse {
                event_id,
                pos,
                button,
            } => {
                map.serialize_entry("eventId", event_id)?;
                map.serialize_entry("pos", pos)?;
                map.serialize_entry("button", button)?;
            }
            Action::W3Api {
                command_id,
                data,
                buffer,
            } => {
                map.serialize_entry("commandId", command_id)?;
                map.serialize_entry("data", data)?;
                map.serialize_entry("buffer", buffer)?;
            }
            Action::BlzSync { identifier, value } => {
                map.serialize_entry("identifier", identifier)?;
                map.serialize_entry("value", value)?;
            }
            Action::CommandFrame {
                event_id,
                val,
                text,
            } => {
                map.serialize_entry("eventId", event_id)?;
                map.serialize_entry("val", val)?;
                map.serialize_entry("text", text)?;
            }
            #[cfg(feature = "extended-actions")]
            Action::ChangeAllyOptions { slot, flags } => {
                map.serialize_entry("slot", slot)?;
                map.serialize_entry("flags", flags)?;
            }
            #[cfg(feature = "extended-actions")]
            Action::MapTriggerChatCommand {
                unknown_a,
                unknown_b,
                command,
            } => {
                map.serialize_entry("unknownA", unknown_a)?;
                map.serialize_entry("unknownB", unknown_b)?;
                map.serialize_entry("command", command)?;
            }
            #[cfg(feature = "extended-actions")]
            Action::ScenarioTrigger {
                unknown_a,
                unknown_b,
                counter,
            } => {
                map.serialize_entry("unknownA", unknown_a)?;
                map.serialize_entry("unknownB", unknown_b)?;
                map.serialize_entry("counter", counter)?;
            }
            #[cfg(feature = "extended-actions")]
            Action::ContinueGameBlockB { a, b, c, d }
            | Action::ContinueGameBlockA { a, b, c, d } => {
                map.serialize_entry("a", a)?;
                map.serialize_entry("b", b)?;
                map.serialize_entry("c", c)?;
                map.serialize_entry("d", d)?;
            }
            #[cfg(feature = "extended-actions")]
            Action::CommandCardSource {
                source_unit_tag,
                ability_id,
                order_id,
                raw_opcode,
                normalized_opcode,
            } => {
                map.serialize_entry("sourceUnitTag", source_unit_tag)?;
                map.serialize_entry("abilityId", ability_id)?;
                map.serialize_entry("orderId", order_id)?;
                map.serialize_entry("rawOpcode", raw_opcode)?;
                map.serialize_entry("normalizedOpcode", normalized_opcode)?;
            }
            #[cfg(feature = "extended-actions")]
            Action::OpaqueDroppedAction {
                raw_opcode,
                normalized_opcode,
                payload,
            } => {
                map.serialize_entry("rawOpcode", raw_opcode)?;
                map.serialize_entry("normalizedOpcode", normalized_opcode)?;
                map.serialize_entry("payload", payload)?;
            }
        }

        map.end()
    }
}

fn serialize_two_target_action<S>(
    map: &mut S,
    fields: TwoTargetActionFields<'_>,
) -> std::result::Result<(), S::Error>
where
    S: SerializeMap,
{
    map.serialize_entry("abilityFlags", fields.ability_flags)?;
    map.serialize_entry("orderId1", fields.order_id1)?;
    map.serialize_entry("targetA", fields.target_a)?;
    map.serialize_entry("orderId2", fields.order_id2)?;
    map.serialize_entry("flags", fields.flags)?;
    map.serialize_entry("category", fields.category)?;
    map.serialize_entry("owner", fields.owner)?;
    map.serialize_entry("targetB", fields.target_b)?;
    Ok(())
}

struct TwoTargetActionFields<'a> {
    ability_flags: &'a u16,
    order_id1: &'a FourCC,
    target_a: &'a Vec2,
    order_id2: &'a FourCC,
    flags: &'a u32,
    category: &'a u32,
    owner: &'a u8,
    target_b: &'a Vec2,
}

#[cfg(feature = "extended-actions")]
fn opaque_dropped_action(raw_opcode: u8, normalized_opcode: u8, payload: Vec<u8>) -> Action {
    Action::OpaqueDroppedAction {
        raw_opcode,
        normalized_opcode,
        payload,
    }
}

fn parse_fixed_opaque_or_skip(
    parser: &mut StatefulBufferParser<'_>,
    raw_opcode: u8,
    normalized_opcode: u8,
    payload_len: usize,
) -> Result<Option<Action>> {
    #[cfg(feature = "extended-actions")]
    {
        let payload = parser.read_bytes(payload_len)?.to_vec();
        Ok(Some(opaque_dropped_action(
            raw_opcode,
            normalized_opcode,
            payload,
        )))
    }
    #[cfg(not(feature = "extended-actions"))]
    {
        let _ = (raw_opcode, normalized_opcode);
        parser.skip(payload_len as isize)?;
        Ok(None)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cache {
    pub filename: String,
    pub mission_key: String,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub item_id: FourCC,
    pub charges: u32,
    pub flags: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ability {
    pub id: FourCC,
    pub level: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeroData {
    pub xp: u32,
    pub level: u32,
    pub skill_points: u32,
    pub proper_name_id: u32,
    pub str: u32,
    pub str_bonus: f32,
    pub agi: u32,
    pub speed_mod: f32,
    pub cooldown_mod: f32,
    pub agi_bonus: f32,
    pub intel: u32,
    pub int_bonus: f32,
    pub hero_abils: Vec<Ability>,
    pub max_life: f32,
    pub max_mana: f32,
    pub sight: f32,
    pub damage: Vec<u32>,
    pub defense: f32,
    pub control_groups: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unit {
    pub unit_id: FourCC,
    pub items: Vec<Item>,
    pub hero_data: HeroData,
}

#[derive(Debug, Default)]
pub struct ActionParser {
    old_action_id: u8,
}

impl ActionParser {
    pub fn new() -> Self {
        Self {
            old_action_id: u8::MAX,
        }
    }

    pub fn parse(&mut self, input: &[u8], is_post_202_replay_format: bool) -> Result<Vec<Action>> {
        let mut parser = StatefulBufferParser::new(input);
        let mut actions = Vec::new();

        while !parser.is_done() {
            let action_id = parser.read_u8()?;
            match self.parse_action(&mut parser, action_id, is_post_202_replay_format) {
                Ok(Some(action)) => actions.push(action),
                Ok(None) => {}
                Err(Error::UnexpectedEof { .. }) => break,
                Err(error) => return Err(error),
            }
        }

        Ok(actions)
    }

    pub(crate) fn parse_summary_with<V>(
        &mut self,
        input: &[u8],
        is_post_202_replay_format: bool,
        visitor: &mut V,
    ) -> Result<()>
    where
        V: SummaryActionVisitor,
    {
        let mut parser = SummaryActionCursor::new(input);

        while !parser.is_done() {
            let action_id = parser.read_u8()?;
            match self.parse_summary_action(
                &mut parser,
                action_id,
                is_post_202_replay_format,
                visitor,
            ) {
                Ok(_) => {}
                Err(Error::UnexpectedEof { .. }) => break,
                Err(error) => return Err(error),
            }
        }

        Ok(())
    }

    pub(crate) fn parse_summary_with_stats<V>(
        &mut self,
        input: &[u8],
        is_post_202_replay_format: bool,
        stats: &mut SummaryActionStats,
        visitor: &mut V,
    ) -> Result<()>
    where
        V: SummaryActionVisitor,
    {
        let mut parser = SummaryActionCursor::new(input);

        while !parser.is_done() {
            let action_id = parser.read_u8()?;
            stats.actions += 1;
            match self.parse_summary_action(
                &mut parser,
                action_id,
                is_post_202_replay_format,
                visitor,
            ) {
                Ok(true) => {
                    stats.emitted_actions += 1;
                }
                Ok(false) => stats.ignored_actions += 1,
                Err(Error::UnexpectedEof { .. }) => break,
                Err(error) => return Err(error),
            }
        }

        Ok(())
    }

    fn parse_action(
        &mut self,
        parser: &mut StatefulBufferParser<'_>,
        action_id: u8,
        is_post_202_replay_format: bool,
    ) -> Result<Option<Action>> {
        let raw_action_id = action_id;
        let normalized_action_id = normalize_action_id(action_id, is_post_202_replay_format);
        let result = self.parse_action_fields(parser, raw_action_id, normalized_action_id)?;
        self.old_action_id = normalized_action_id;
        Ok(result)
    }

    fn parse_summary_action(
        &mut self,
        parser: &mut SummaryActionCursor<'_>,
        action_id: u8,
        is_post_202_replay_format: bool,
        visitor: &mut impl SummaryActionVisitor,
    ) -> Result<bool> {
        let action_id = normalize_action_id(action_id, is_post_202_replay_format);
        let result = match action_id {
            0x01 => {
                parser.skip(1)?;
                false
            }
            0x02 => false,
            0x03 => {
                parser.skip(1)?;
                false
            }
            0x04 | 0x05 => false,
            0x06 => {
                parser.skip_zero_term_string()?;
                parser.skip_zero_term_string()?;
                parser.skip(1)?;
                false
            }
            0x07 => {
                parser.skip(4)?;
                false
            }
            0x10 => {
                parser.skip(2)?;
                let order_id = parser.read_fourcc()?;
                parser.skip(8)?;
                visitor.unit_building_ability_no_params(order_id)?;
                true
            }
            0x11 => {
                parser.skip(2)?;
                let order_id = parser.read_fourcc()?;
                parser.skip(16)?;
                visitor.unit_building_ability_target_position(order_id)?;
                true
            }
            0x12 => {
                parser.skip(2)?;
                let order_id = parser.read_fourcc()?;
                parser.skip(24)?;
                visitor.unit_building_ability_target_position_object(order_id)?;
                true
            }
            0x13 => {
                parser.skip(38)?;
                visitor.give_item_to_unit()?;
                true
            }
            0x14 => {
                parser.skip(2)?;
                let order_id1 = parser.read_fourcc()?;
                parser.skip(37)?;
                visitor.unit_building_ability_two_target_positions(order_id1)?;
                true
            }
            0x15 => {
                parser.skip(51)?;
                false
            }
            0x19 => {
                parser.skip(12)?;
                false
            }
            0x1a => false,
            0x1b => {
                parser.skip(9)?;
                false
            }
            0x16 => {
                let select_mode = parser.read_u8()?;
                let number_units = parser.read_u16_le()?;
                parser.skip_selection_units(number_units)?;
                visitor.change_selection(select_mode)?;
                true
            }
            0x17 => {
                let group_number = parser.read_u8()?;
                let number_units = parser.read_u16_le()?;
                parser.skip_selection_units(number_units)?;
                visitor.assign_group_hotkey(group_number)?;
                true
            }
            0x18 => {
                let group_number = parser.read_u8()?;
                parser.skip(1)?;
                visitor.select_group_hotkey(group_number)?;
                true
            }
            0x1c => {
                parser.skip(9)?;
                visitor.select_ground_item()?;
                true
            }
            0x1d => {
                parser.skip(8)?;
                visitor.cancel_hero_revival()?;
                true
            }
            0x1e | 0x1f => {
                parser.skip(5)?;
                visitor.remove_unit_from_building_queue()?;
                true
            }
            0x20 => false,
            0x21 => {
                parser.skip(8)?;
                false
            }
            0x22..=0x26 => false,
            0x27 | 0x28 => {
                parser.skip(5)?;
                false
            }
            0x29..=0x2c => false,
            0x2d => {
                parser.skip(5)?;
                false
            }
            0x2e => {
                parser.skip(4)?;
                false
            }
            0x2f => false,
            0x50 => {
                parser.skip(5)?;
                false
            }
            0x51 => {
                let slot = parser.read_u8()?;
                let gold = parser.read_u32_le()?;
                let lumber = parser.read_u32_le()?;
                visitor.transfer_resources(slot, gold, lumber)?;
                true
            }
            0x60 => {
                parser.skip(8)?;
                parser.skip_zero_term_string()?;
                false
            }
            0x61 => {
                visitor.esc_pressed()?;
                true
            }
            0x62 => {
                parser.skip(12)?;
                false
            }
            0x63 | 0x64 => {
                parser.skip(8)?;
                false
            }
            0x65 => {
                parser.skip(8)?;
                false
            }
            0x66 => {
                visitor.choose_hero_skill_submenu()?;
                true
            }
            0x67 => {
                visitor.enter_building_submenu()?;
                true
            }
            0x68 => {
                parser.skip(12)?;
                false
            }
            0x69 | 0x6a => {
                parser.skip(16)?;
                false
            }
            0x6b | 0x6c => {
                parser.skip_cache_desc()?;
                parser.skip(4)?;
                false
            }
            0x6d => {
                parser.skip_cache_desc()?;
                parser.skip(1)?;
                false
            }
            0x6e => {
                parser.skip_cache_desc()?;
                parser.skip_cache_unit()?;
                false
            }
            0x70..=0x73 => {
                parser.skip_cache_desc()?;
                false
            }
            0x75 => {
                parser.skip(1)?;
                false
            }
            0x76 => {
                parser.skip(10)?;
                false
            }
            0x77 => {
                parser.skip(8)?;
                let buff_len = parser.read_u32_le()? as usize;
                parser.skip(buff_len)?;
                false
            }
            0x78 => {
                parser.skip_zero_term_string()?;
                parser.skip_zero_term_string()?;
                parser.skip(4)?;
                false
            }
            0x79 => {
                parser.skip(16)?;
                parser.skip_zero_term_string()?;
                false
            }
            0x7a => {
                parser.skip(20)?;
                false
            }
            0x7b => {
                parser.skip(16)?;
                false
            }
            0xa0 => {
                parser.skip(14)?;
                false
            }
            0xa1 => {
                parser.skip(9)?;
                false
            }
            _ => false,
        };

        self.old_action_id = action_id;
        Ok(result)
    }

    fn parse_action_fields(
        &mut self,
        parser: &mut StatefulBufferParser<'_>,
        raw_action_id: u8,
        action_id: u8,
    ) -> Result<Option<Action>> {
        #[cfg(not(feature = "extended-actions"))]
        let _ = raw_action_id;

        let result = match action_id {
            0x01 => {
                parser.skip(1)?;
                None
            }
            0x02 => {
                #[cfg(feature = "extended-actions")]
                {
                    Some(opaque_dropped_action(raw_action_id, action_id, Vec::new()))
                }
                #[cfg(not(feature = "extended-actions"))]
                {
                    None
                }
            }
            0x03 => Some(Action::SetGameSpeed {
                game_speed: parser.read_u8()?,
            }),
            0x04 | 0x05 => None,
            0x06 => {
                let _ = parser.read_zero_term_string()?;
                let _ = parser.read_zero_term_string()?;
                let _ = parser.read_u8()?;
                None
            }
            0x07 => {
                parser.skip(4)?;
                None
            }
            0x10 => {
                let ability_flags = parser.read_u16_le()?;
                let order_id = read_fourcc(parser)?;
                parser.skip(8)?;
                Some(Action::UnitBuildingAbilityNoParams {
                    ability_flags,
                    order_id,
                })
            }
            0x11 => {
                let ability_flags = parser.read_u16_le()?;
                let order_id = read_fourcc(parser)?;
                parser.skip(8)?;
                let target = read_vec2(parser)?;
                Some(Action::UnitBuildingAbilityTargetPosition {
                    ability_flags,
                    order_id,
                    target,
                })
            }
            0x12 => {
                let ability_flags = parser.read_u16_le()?;
                let order_id = read_fourcc(parser)?;
                parser.skip(8)?;
                let target = read_vec2(parser)?;
                let object = read_net_tag(parser)?;
                Some(Action::UnitBuildingAbilityTargetPositionObject {
                    ability_flags,
                    order_id,
                    target,
                    object,
                })
            }
            0x13 => {
                let ability_flags = parser.read_u16_le()?;
                let order_id = read_fourcc(parser)?;
                parser.skip(8)?;
                let target = read_vec2(parser)?;
                let unit = read_net_tag(parser)?;
                let item = read_net_tag(parser)?;
                Some(Action::GiveItemToUnit {
                    ability_flags,
                    order_id,
                    target,
                    unit,
                    item,
                })
            }
            0x14 => {
                let ability_flags = parser.read_u16_le()?;
                let order_id1 = read_fourcc(parser)?;
                parser.skip(8)?;
                let target_a = read_vec2(parser)?;
                let order_id2 = read_fourcc(parser)?;
                let flags = parser.read_u32_le()?;
                let category = parser.read_u32_le()?;
                let owner = parser.read_u8()?;
                let target_b = read_vec2(parser)?;
                Some(Action::UnitBuildingAbilityTwoTargetPositions {
                    ability_flags,
                    order_id1,
                    target_a,
                    order_id2,
                    flags,
                    category,
                    owner,
                    target_b,
                })
            }
            0x15 => {
                let ability_flags = parser.read_u16_le()?;
                let order_id1 = read_fourcc(parser)?;
                parser.skip(8)?;
                let target_a = read_vec2(parser)?;
                let order_id2 = read_fourcc(parser)?;
                let flags = parser.read_u32_le()?;
                let category = parser.read_u32_le()?;
                let owner = parser.read_u8()?;
                let target_b = read_vec2(parser)?;
                let object = read_net_tag(parser)?;
                Some(Action::UnitBuildingAbilityTargetPositionObjectItem {
                    ability_flags,
                    order_id1,
                    target_a,
                    order_id2,
                    flags,
                    category,
                    owner,
                    target_b,
                    object,
                })
            }
            0x16 => {
                let select_mode = parser.read_u8()?;
                let number_units = parser.read_u16_le()?;
                let units = read_selection_units(parser, number_units)?;
                Some(Action::ChangeSelection {
                    select_mode,
                    number_units,
                    units,
                })
            }
            0x17 => {
                let group_number = parser.read_u8()?;
                let number_units = parser.read_u16_le()?;
                let units = read_selection_units(parser, number_units)?;
                Some(Action::AssignGroupHotkey {
                    group_number,
                    number_units,
                    units,
                })
            }
            0x18 => {
                let group_number = parser.read_u8()?;
                parser.skip(1)?;
                Some(Action::SelectGroupHotkey { group_number })
            }
            0x19 => {
                let item_id = read_fourcc(parser)?;
                let object = read_net_tag(parser)?;
                Some(Action::SelectSubgroup { item_id, object })
            }
            0x1a => Some(Action::PreSubselection),
            0x1b => {
                parser.skip(1)?;
                let object = read_net_tag(parser)?;
                Some(Action::SelectUnit { object })
            }
            0x1c => {
                parser.skip(1)?;
                let item = read_net_tag(parser)?;
                Some(Action::SelectGroundItem { item })
            }
            0x1d => {
                let hero = read_net_tag(parser)?;
                Some(Action::CancelHeroRevival { hero })
            }
            0x1e | 0x1f => {
                let slot_number = parser.read_u8()?;
                let item_id = read_fourcc(parser)?;
                Some(Action::RemoveUnitFromBuildingQueue {
                    action_id,
                    slot_number,
                    item_id,
                })
            }
            0x20 => None,
            0x21 => {
                parser.skip(8)?;
                None
            }
            0x22..=0x26 => None,
            0x27 | 0x28 => {
                parser.skip(5)?;
                None
            }
            0x29..=0x2c => None,
            0x2d => {
                parser.skip(5)?;
                None
            }
            0x2e => {
                parser.skip(4)?;
                None
            }
            0x2f => None,
            0x50 => {
                #[cfg(feature = "extended-actions")]
                {
                    Some(Action::ChangeAllyOptions {
                        slot: parser.read_u8()?,
                        flags: parser.read_u32_le()?,
                    })
                }
                #[cfg(not(feature = "extended-actions"))]
                {
                    parser.skip(5)?;
                    None
                }
            }
            0x51 => {
                let slot = parser.read_u8()?;
                let gold = parser.read_u32_le()?;
                let lumber = parser.read_u32_le()?;
                Some(Action::TransferResources { slot, gold, lumber })
            }
            0x60 => {
                #[cfg(feature = "extended-actions")]
                {
                    Some(Action::MapTriggerChatCommand {
                        unknown_a: parser.read_u32_le()?,
                        unknown_b: parser.read_u32_le()?,
                        command: parser.read_zero_term_string()?,
                    })
                }
                #[cfg(not(feature = "extended-actions"))]
                {
                    parser.skip(8)?;
                    let _ = parser.read_zero_term_string()?;
                    None
                }
            }
            0x61 => Some(Action::EscPressed),
            0x62 => {
                #[cfg(feature = "extended-actions")]
                {
                    Some(Action::ScenarioTrigger {
                        unknown_a: parser.read_u32_le()?,
                        unknown_b: parser.read_u32_le()?,
                        counter: parser.read_u32_le()?,
                    })
                }
                #[cfg(not(feature = "extended-actions"))]
                {
                    parser.skip(12)?;
                    None
                }
            }
            0x63 => {
                parser.skip(8)?;
                None
            }
            0x64 => Some(Action::TrackableHit {
                object: read_net_tag(parser)?,
            }),
            0x65 => Some(Action::TrackableTrack {
                object: read_net_tag(parser)?,
            }),
            0x66 => Some(Action::ChooseHeroSkillSubmenu),
            0x67 => Some(Action::EnterBuildingSubmenu),
            0x68 => {
                let pos = read_vec2(parser)?;
                let duration = parser.read_f32_le()?;
                Some(Action::AllyPing { pos, duration })
            }
            0x69 => {
                #[cfg(feature = "extended-actions")]
                {
                    let c = parser.read_u32_le()?;
                    let d = parser.read_u32_le()?;
                    let a = parser.read_u32_le()?;
                    let b = parser.read_u32_le()?;
                    Some(Action::ContinueGameBlockB { a, b, c, d })
                }
                #[cfg(not(feature = "extended-actions"))]
                {
                    parser.skip(16)?;
                    None
                }
            }
            0x6a => {
                #[cfg(feature = "extended-actions")]
                {
                    Some(Action::ContinueGameBlockA {
                        a: parser.read_u32_le()?,
                        b: parser.read_u32_le()?,
                        c: parser.read_u32_le()?,
                        d: parser.read_u32_le()?,
                    })
                }
                #[cfg(not(feature = "extended-actions"))]
                {
                    parser.skip(16)?;
                    None
                }
            }
            0x6b => {
                let cache = read_cache_desc(parser)?;
                let value = parser.read_u32_le()?;
                Some(Action::BlzCacheStoreInt { cache, value })
            }
            0x6c => {
                let cache = read_cache_desc(parser)?;
                let value = parser.read_f32_le()?;
                Some(Action::BlzCacheStoreReal { cache, value })
            }
            0x6d => {
                let cache = read_cache_desc(parser)?;
                let value = parser.read_u8()?;
                Some(Action::BlzCacheStoreBoolean { cache, value })
            }
            0x6e => {
                let cache = read_cache_desc(parser)?;
                let value = read_cache_unit(parser)?;
                Some(Action::BlzCacheStoreUnit { cache, value })
            }
            0x70 => Some(Action::BlzCacheClearInt {
                cache: read_cache_desc(parser)?,
            }),
            0x71 => Some(Action::BlzCacheClearReal {
                cache: read_cache_desc(parser)?,
            }),
            0x72 => Some(Action::BlzCacheClearBoolean {
                cache: read_cache_desc(parser)?,
            }),
            0x73 => Some(Action::BlzCacheClearUnit {
                cache: read_cache_desc(parser)?,
            }),
            0x75 => Some(Action::ArrowKey {
                arrow_key: parser.read_u8()?,
            }),
            0x76 => {
                let event_id = parser.read_u8()?;
                let pos = read_vec2(parser)?;
                let button = parser.read_u8()?;
                Some(Action::Mouse {
                    event_id,
                    pos,
                    button,
                })
            }
            0x77 => {
                let command_id = parser.read_u32_le()?;
                let data = parser.read_u32_le()?;
                let buff_len = parser.read_u32_le()? as usize;
                let buffer = parser.read_string(buff_len)?;
                Some(Action::W3Api {
                    command_id,
                    data,
                    buffer,
                })
            }
            0x78 => {
                let identifier = parser.read_zero_term_string()?;
                let value = parser.read_zero_term_string()?;
                parser.skip(4)?;
                Some(Action::BlzSync { identifier, value })
            }
            0x79 => {
                parser.skip(8)?;
                let event_id = parser.read_u32_le()?;
                let val = parser.read_f32_le()?;
                let text = parser.read_zero_term_string()?;
                Some(Action::CommandFrame {
                    event_id,
                    val,
                    text,
                })
            }
            0x7a => parse_fixed_opaque_or_skip(parser, raw_action_id, action_id, 20)?,
            0x7b => {
                #[cfg(feature = "extended-actions")]
                {
                    let source_unit_tag = read_net_tag(parser)?;
                    let ability_id = read_fourcc(parser)?;
                    let order_id = read_fourcc(parser)?;
                    Some(Action::CommandCardSource {
                        source_unit_tag,
                        ability_id,
                        order_id,
                        raw_opcode: raw_action_id,
                        normalized_opcode: action_id,
                    })
                }
                #[cfg(not(feature = "extended-actions"))]
                {
                    parser.skip(16)?;
                    None
                }
            }
            0xa0 => {
                parser.skip(14)?;
                None
            }
            0xa1 => {
                parser.skip(9)?;
                None
            }
            _ => None,
        };

        Ok(result)
    }
}

struct SummaryActionCursor<'a> {
    buffer: &'a [u8],
    offset: usize,
}

impl<'a> SummaryActionCursor<'a> {
    fn new(buffer: &'a [u8]) -> Self {
        Self { buffer, offset: 0 }
    }

    fn is_done(&self) -> bool {
        self.offset >= self.buffer.len()
    }

    fn read_u8(&mut self) -> Result<u8> {
        self.ensure(1)?;
        let value = self.buffer[self.offset];
        self.offset += 1;
        Ok(value)
    }

    fn read_u16_le(&mut self) -> Result<u16> {
        self.ensure(2)?;
        let offset = self.offset;
        self.offset += 2;
        Ok(u16::from_le_bytes([
            self.buffer[offset],
            self.buffer[offset + 1],
        ]))
    }

    fn read_u32_le(&mut self) -> Result<u32> {
        self.ensure(4)?;
        let offset = self.offset;
        self.offset += 4;
        Ok(u32::from_le_bytes([
            self.buffer[offset],
            self.buffer[offset + 1],
            self.buffer[offset + 2],
            self.buffer[offset + 3],
        ]))
    }

    fn read_fourcc(&mut self) -> Result<FourCC> {
        self.ensure(4)?;
        let offset = self.offset;
        self.offset += 4;
        Ok([
            self.buffer[offset],
            self.buffer[offset + 1],
            self.buffer[offset + 2],
            self.buffer[offset + 3],
        ])
    }

    fn skip(&mut self, byte_count: usize) -> Result<()> {
        self.ensure(byte_count)?;
        self.offset += byte_count;
        Ok(())
    }

    fn skip_selection_units(&mut self, length: u16) -> Result<()> {
        self.skip(usize::from(length) * 8)
    }

    fn skip_zero_term_string(&mut self) -> Result<()> {
        let start = self.offset;
        let remaining = &self.buffer[start..];
        let length = remaining
            .iter()
            .position(|byte| *byte == 0)
            .ok_or(Error::UnexpectedEof {
                offset: start,
                needed: 1,
            })?;
        self.skip(length + 1)
    }

    fn skip_cache_desc(&mut self) -> Result<()> {
        self.skip_zero_term_string()?;
        self.skip_zero_term_string()?;
        self.skip_zero_term_string()
    }

    fn skip_cache_unit(&mut self) -> Result<()> {
        self.skip(4)?;
        let items_count = self.read_u32_le()?;
        let items_count = usize::try_from(items_count)
            .map_err(|_| Error::Message("cache item count overflow".to_string()))?;
        for _ in 0..items_count {
            self.skip(12)?;
        }
        self.skip_cache_hero_data()
    }

    fn skip_cache_hero_data(&mut self) -> Result<()> {
        self.skip(48)?;
        let hero_abil_count = self.read_u32_le()?;
        let hero_abil_count = usize::try_from(hero_abil_count)
            .map_err(|_| Error::Message("hero ability count overflow".to_string()))?;
        for _ in 0..hero_abil_count {
            self.skip(8)?;
        }
        self.skip(12)?;
        let damage_count = self.read_u32_le()?;
        let damage_byte_count = usize::try_from(damage_count)
            .ok()
            .and_then(|count| count.checked_mul(4))
            .ok_or_else(|| Error::Message("damage count overflow".to_string()))?;
        self.skip(damage_byte_count)?;
        self.skip(6)
    }

    fn ensure(&self, needed: usize) -> Result<()> {
        let Some(end) = self.offset.checked_add(needed) else {
            return Err(Error::UnexpectedEof {
                offset: self.offset,
                needed,
            });
        };
        if end > self.buffer.len() {
            return Err(Error::UnexpectedEof {
                offset: self.offset,
                needed,
            });
        }
        Ok(())
    }
}

fn normalize_action_id(action_id: u8, is_post_202_replay_format: bool) -> u8 {
    if is_post_202_replay_format && action_id > 0x77 {
        action_id.saturating_add(1)
    } else {
        action_id
    }
}

fn read_selection_units(parser: &mut StatefulBufferParser<'_>, length: u16) -> Result<Vec<NetTag>> {
    let mut units = Vec::with_capacity(length as usize);
    for _ in 0..length {
        units.push(read_net_tag(parser)?);
    }
    Ok(units)
}

fn read_fourcc(parser: &mut StatefulBufferParser<'_>) -> Result<FourCC> {
    Ok([
        parser.read_u8()?,
        parser.read_u8()?,
        parser.read_u8()?,
        parser.read_u8()?,
    ])
}

fn read_cache_desc(parser: &mut StatefulBufferParser<'_>) -> Result<Cache> {
    let filename = parser.read_zero_term_string()?;
    let mission_key = parser.read_zero_term_string()?;
    let key = parser.read_zero_term_string()?;
    Ok(Cache {
        filename,
        mission_key,
        key,
    })
}

fn read_cache_item(parser: &mut StatefulBufferParser<'_>) -> Result<Item> {
    let item_id = read_fourcc(parser)?;
    let charges = parser.read_u32_le()?;
    let flags = parser.read_u32_le()?;
    Ok(Item {
        item_id,
        charges,
        flags,
    })
}

fn read_ability(parser: &mut StatefulBufferParser<'_>) -> Result<Ability> {
    let id = read_fourcc(parser)?;
    let level = parser.read_u32_le()?;
    Ok(Ability { id, level })
}

fn read_cache_hero_data(parser: &mut StatefulBufferParser<'_>) -> Result<HeroData> {
    let xp = parser.read_u32_le()?;
    let level = parser.read_u32_le()?;
    let skill_points = parser.read_u32_le()?;
    let proper_name_id = parser.read_u32_le()?;
    let str = parser.read_u32_le()?;
    let str_bonus = parser.read_f32_le()?;
    let agi = parser.read_u32_le()?;
    let speed_mod = parser.read_f32_le()?;
    let cooldown_mod = parser.read_f32_le()?;
    let agi_bonus = parser.read_f32_le()?;
    let intel = parser.read_u32_le()?;
    let int_bonus = parser.read_f32_le()?;
    let hero_abil_count = parser.read_u32_le()?;
    let mut hero_abils = Vec::with_capacity(hero_abil_count as usize);
    for _ in 0..hero_abil_count {
        hero_abils.push(read_ability(parser)?);
    }
    let max_life = parser.read_f32_le()?;
    let max_mana = parser.read_f32_le()?;
    let sight = parser.read_f32_le()?;
    let damage_count = parser.read_u32_le()?;
    let mut damage = Vec::with_capacity(damage_count as usize);
    for _ in 0..damage_count {
        damage.push(parser.read_u32_le()?);
    }
    let defense = parser.read_f32_le()?;
    let control_groups = parser.read_u16_le()?;

    Ok(HeroData {
        xp,
        level,
        skill_points,
        proper_name_id,
        str,
        str_bonus,
        agi,
        speed_mod,
        cooldown_mod,
        agi_bonus,
        intel,
        int_bonus,
        hero_abils,
        max_life,
        max_mana,
        sight,
        damage,
        defense,
        control_groups,
    })
}

fn read_cache_unit(parser: &mut StatefulBufferParser<'_>) -> Result<Unit> {
    let unit_id = read_fourcc(parser)?;
    let items_count = parser.read_u32_le()?;
    let mut items = Vec::with_capacity(items_count as usize);
    for _ in 0..items_count {
        items.push(read_cache_item(parser)?);
    }
    let hero_data = read_cache_hero_data(parser)?;
    Ok(Unit {
        unit_id,
        items,
        hero_data,
    })
}

fn read_net_tag(parser: &mut StatefulBufferParser<'_>) -> Result<NetTag> {
    Ok([parser.read_u32_le()?, parser.read_u32_le()?])
}

fn read_vec2(parser: &mut StatefulBufferParser<'_>) -> Result<Vec2> {
    Ok([parser.read_f32_le()?, parser.read_f32_le()?])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{game_data::GameDataParser, metadata::MetadataParser, raw::RawParser};

    #[test]
    fn parses_actions_from_fixture_timeslots() {
        let bytes = include_bytes!("../fixtures/replays/132/netease_132.nwg");
        let raw = RawParser::new().parse(bytes).unwrap();
        let metadata = MetadataParser::new().parse(&raw.blocks).unwrap();
        let blocks = GameDataParser::new()
            .parse(&metadata.game_data, metadata.is_post_202_replay_format)
            .unwrap();

        let action_count = blocks
            .iter()
            .flat_map(|block| match block {
                crate::game_data::GameDataBlock::Timeslot(timeslot) => {
                    timeslot.command_blocks.iter().collect::<Vec<_>>()
                }
                _ => Vec::new(),
            })
            .map(|command| command.actions.len())
            .sum::<usize>();

        assert!(action_count > 0);
    }

    #[test]
    fn formats_fourcc_and_net_tags_for_downstream_adapters() {
        assert_eq!(format_fourcc_or_hex(*b"trah"), "hart");
        assert_eq!(format_fourcc_or_hex([0x03, 0, 0, 0]), "0x03000000");
        assert_eq!(format_net_tag([1, 2]), "n:1:2");
        assert_eq!(format_optional_net_tag([1, 2]), Some("n:1:2".to_string()));
        assert_eq!(format_optional_net_tag([u32::MAX, u32::MAX]), None);
    }

    #[test]
    #[cfg(not(feature = "extended-actions"))]
    fn drops_post_202_command_card_source_by_default() {
        let input = [
            0x7a, 0x73, 0x55, 0x00, 0x00, 0x73, 0x55, 0x00, 0x00, 0x75, 0x62, 0x4f, 0x41, 0x74,
            0x6c, 0x61, 0x6f,
        ];

        let actions = ActionParser::new().parse(&input, true).unwrap();

        assert!(actions.is_empty());
    }

    #[test]
    #[cfg(not(feature = "extended-actions"))]
    fn drops_named_extended_actions_by_default() {
        let input = [
            0x50, 0x03, 0x44, 0x33, 0x22, 0x11, 0x60, 0x88, 0x77, 0x66, 0x55, 0xcc, 0xbb, 0xaa,
            0x99, b'h', b'i', 0,
        ];

        let actions = ActionParser::new().parse(&input, false).unwrap();

        assert!(actions.is_empty());
    }

    #[cfg(feature = "extended-actions")]
    fn assert_opaque_action(
        action: &Action,
        raw_opcode: u8,
        normalized_opcode: u8,
        payload: &[u8],
    ) {
        let Action::OpaqueDroppedAction {
            raw_opcode: actual_raw_opcode,
            normalized_opcode: actual_normalized_opcode,
            payload: actual_payload,
        } = action
        else {
            panic!("expected opaque dropped action");
        };

        assert_eq!(*actual_raw_opcode, raw_opcode);
        assert_eq!(*actual_normalized_opcode, normalized_opcode);
        assert_eq!(actual_payload.as_slice(), payload);
        assert_eq!(action.id(), normalized_opcode);
    }

    #[test]
    #[cfg(feature = "extended-actions")]
    fn emits_opaque_dropped_actions_when_extended_actions_are_enabled() {
        let mut input = Vec::new();
        input.push(0x02);
        let payload_7a: Vec<_> = (80u8..=99).collect();
        input.push(0x7a);
        input.extend_from_slice(&payload_7a);

        let actions = ActionParser::new().parse(&input, false).unwrap();

        assert_eq!(actions.len(), 2);
        assert_opaque_action(&actions[0], 0x02, 0x02, &[]);
        assert_opaque_action(&actions[1], 0x7a, 0x7a, &payload_7a);

        let json = serde_json::to_value(&actions[1]).unwrap();
        assert_eq!(json["id"], 0x7a);
        assert_eq!(json["rawOpcode"], 0x7a);
        assert_eq!(json["normalizedOpcode"], 0x7a);
        assert_eq!(json["payload"], serde_json::json!(payload_7a));
    }

    #[test]
    #[cfg(feature = "extended-actions")]
    fn emits_change_ally_options_when_extended_actions_are_enabled() {
        let input = [0x50, 0x03, 0x44, 0x33, 0x22, 0x11];

        let actions = ActionParser::new().parse(&input, false).unwrap();

        assert_eq!(actions.len(), 1);
        let Action::ChangeAllyOptions { slot, flags } = &actions[0] else {
            panic!("expected change ally options action");
        };
        assert_eq!(*slot, 3);
        assert_eq!(*flags, 0x11223344);
        assert_eq!(actions[0].id(), 0x50);

        let json = serde_json::to_value(&actions[0]).unwrap();
        assert_eq!(json["id"], 0x50);
        assert_eq!(json["slot"], 3);
        assert_eq!(json["flags"], 0x11223344);
    }

    #[test]
    #[cfg(feature = "extended-actions")]
    fn emits_map_trigger_chat_command_when_extended_actions_are_enabled() {
        let input = [
            0x60, 0x88, 0x77, 0x66, 0x55, 0xcc, 0xbb, 0xaa, 0x99, b'h', b'i', 0,
        ];

        let actions = ActionParser::new().parse(&input, false).unwrap();

        assert_eq!(actions.len(), 1);
        let Action::MapTriggerChatCommand {
            unknown_a,
            unknown_b,
            command,
        } = &actions[0]
        else {
            panic!("expected map trigger chat command action");
        };
        assert_eq!(*unknown_a, 0x55667788);
        assert_eq!(*unknown_b, 0x99aabbcc);
        assert_eq!(command, "hi");
        assert_eq!(actions[0].id(), 0x60);

        let json = serde_json::to_value(&actions[0]).unwrap();
        assert_eq!(json["id"], 0x60);
        assert_eq!(json["unknownA"], serde_json::json!(0x55667788u32));
        assert_eq!(json["unknownB"], serde_json::json!(0x99aabbccu32));
        assert_eq!(json["command"], "hi");
    }

    #[test]
    #[cfg(feature = "extended-actions")]
    fn emits_scenario_trigger_when_extended_actions_are_enabled() {
        let input = [
            0x62, 0x04, 0x03, 0x02, 0x01, 0x08, 0x07, 0x06, 0x05, 0x0c, 0x0b, 0x0a, 0x09,
        ];

        let actions = ActionParser::new().parse(&input, false).unwrap();

        assert_eq!(actions.len(), 1);
        let Action::ScenarioTrigger {
            unknown_a,
            unknown_b,
            counter,
        } = &actions[0]
        else {
            panic!("expected scenario trigger action");
        };
        assert_eq!(*unknown_a, 0x01020304);
        assert_eq!(*unknown_b, 0x05060708);
        assert_eq!(*counter, 0x090a0b0c);
        assert_eq!(actions[0].id(), 0x62);

        let json = serde_json::to_value(&actions[0]).unwrap();
        assert_eq!(json["id"], 0x62);
        assert_eq!(json["unknownA"], serde_json::json!(0x01020304u32));
        assert_eq!(json["unknownB"], serde_json::json!(0x05060708u32));
        assert_eq!(json["counter"], serde_json::json!(0x090a0b0cu32));
    }

    #[test]
    #[cfg(feature = "extended-actions")]
    fn emits_continue_game_blocks_when_extended_actions_are_enabled() {
        let input = [
            0x6a, 0x04, 0x03, 0x02, 0x01, 0x08, 0x07, 0x06, 0x05, 0x0c, 0x0b, 0x0a, 0x09, 0x10,
            0x0f, 0x0e, 0x0d, 0x69, 0x44, 0x33, 0x22, 0x11, 0x88, 0x77, 0x66, 0x55, 0xcc, 0xbb,
            0xaa, 0x99, 0x00, 0xff, 0xee, 0xdd,
        ];

        let actions = ActionParser::new().parse(&input, false).unwrap();

        assert_eq!(actions.len(), 2);
        let Action::ContinueGameBlockA { a, b, c, d } = &actions[0] else {
            panic!("expected continue game block A");
        };
        assert_eq!(
            (*a, *b, *c, *d),
            (0x01020304, 0x05060708, 0x090a0b0c, 0x0d0e0f10)
        );
        assert_eq!(actions[0].id(), 0x6a);

        let Action::ContinueGameBlockB { a, b, c, d } = &actions[1] else {
            panic!("expected continue game block B");
        };
        assert_eq!(
            (*a, *b, *c, *d),
            (0x99aabbcc, 0xddeeff00, 0x11223344, 0x55667788)
        );
        assert_eq!(actions[1].id(), 0x69);

        let block_a_json = serde_json::to_value(&actions[0]).unwrap();
        assert_eq!(block_a_json["id"], 0x6a);
        assert_eq!(block_a_json["a"], serde_json::json!(0x01020304u32));
        assert_eq!(block_a_json["b"], serde_json::json!(0x05060708u32));
        assert_eq!(block_a_json["c"], serde_json::json!(0x090a0b0cu32));
        assert_eq!(block_a_json["d"], serde_json::json!(0x0d0e0f10u32));

        let block_b_json = serde_json::to_value(&actions[1]).unwrap();
        assert_eq!(block_b_json["id"], 0x69);
        assert_eq!(block_b_json["a"], serde_json::json!(0x99aabbccu32));
        assert_eq!(block_b_json["b"], serde_json::json!(0xddeeff00u32));
        assert_eq!(block_b_json["c"], serde_json::json!(0x11223344u32));
        assert_eq!(block_b_json["d"], serde_json::json!(0x55667788u32));
    }

    #[test]
    #[cfg(feature = "extended-actions")]
    fn exposes_post_202_raw_0x79_as_opaque_normalized_0x7a() {
        let mut input = vec![0x79];
        let payload: Vec<_> = (1u8..=20).collect();
        input.extend_from_slice(&payload);

        let actions = ActionParser::new().parse(&input, true).unwrap();

        assert_eq!(actions.len(), 1);
        assert_opaque_action(&actions[0], 0x79, 0x7a, &payload);
    }

    #[test]
    #[cfg(feature = "extended-actions")]
    fn emits_command_card_source_when_extended_actions_are_enabled() {
        let input = [
            0x7a, 0x73, 0x55, 0x00, 0x00, 0x73, 0x55, 0x00, 0x00, 0x75, 0x62, 0x4f, 0x41, 0x74,
            0x6c, 0x61, 0x6f,
        ];

        let actions = ActionParser::new().parse(&input, true).unwrap();

        assert_eq!(actions.len(), 1);
        let Action::CommandCardSource {
            source_unit_tag,
            ability_id,
            order_id,
            raw_opcode,
            normalized_opcode,
        } = &actions[0]
        else {
            panic!("expected command card source action");
        };
        assert_eq!(*source_unit_tag, [21875, 21875]);
        assert_eq!(format_net_tag(*source_unit_tag), "n:21875:21875");
        assert_eq!(*ability_id, *b"ubOA");
        assert_eq!(format_fourcc_or_hex(*ability_id), "AObu");
        assert_eq!(*order_id, *b"tlao");
        assert_eq!(format_fourcc_or_hex(*order_id), "oalt");
        assert_eq!(*raw_opcode, 0x7a);
        assert_eq!(*normalized_opcode, 0x7b);
        assert_eq!(actions[0].id(), 0x7b);

        let json = serde_json::to_value(&actions[0]).unwrap();
        assert_eq!(json["id"], 0x7b);
        assert_eq!(json["sourceUnitTag"], serde_json::json!([21875, 21875]));
        assert_eq!(json["abilityId"], serde_json::json!([117, 98, 79, 65]));
        assert_eq!(json["orderId"], serde_json::json!([116, 108, 97, 111]));
        assert_eq!(json["rawOpcode"], 0x7a);
        assert_eq!(json["normalizedOpcode"], 0x7b);
    }
}
