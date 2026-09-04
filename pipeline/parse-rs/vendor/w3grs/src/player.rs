//! High-level player accumulator port.

use std::collections::HashMap;

use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};

use crate::{
    action::{Action, FourCC},
    convert::player_color,
    formatters::object_id_formatter,
    mappings::{
        ability_to_hero, building_id_for_order_id, building_name, item_id_for_order_id, item_name,
        unit_id_for_order_id, unit_name, upgrade_id_for_order_id, upgrade_name,
    },
    retraining::{
        AbilityOrderEntry, RetrainingHistory, get_retraining_index,
        infer_hero_ability_levels_from_ability_order,
    },
    sort::SortablePlayer,
    types::{ItemId, Race},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectOrderEntry {
    pub id: String,
    pub ms: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectTracker {
    pub summary: HashMap<String, u32>,
    pub order: Vec<ObjectOrderEntry>,
}

impl ObjectTracker {
    // Serde gate for the `unknown` bucket: empty (the case for every replay
    // on a standard melee map) means the field is omitted entirely, keeping
    // melee output byte-identical to upstream w3grs 0.2.3.
    pub fn is_empty(&self) -> bool {
        self.summary.is_empty() && self.order.is_empty()
    }

    fn push(&mut self, id: &str, ms: u32) {
        if let Some(count) = self.summary.get_mut(id) {
            *count += 1;
        } else {
            self.summary.insert(id.to_string(), 1);
        }
        self.order.push(ObjectOrderEntry {
            id: id.to_string(),
            ms,
        });
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeroInfo {
    pub level: u32,
    pub abilities: HashMap<String, u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub retraining_history: Vec<RetrainingHistory>,
    pub ability_order: Vec<AbilityOrderEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HeroCollectorInfo {
    level: u32,
    abilities: HashMap<String, u32>,
    order: u32,
    id: Option<String>,
    retraining_history: Vec<RetrainingHistory>,
    ability_order: Vec<AbilityOrderEntry>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlayerActions {
    pub timed: Vec<u32>,
    pub assigngroup: u32,
    pub rightclick: u32,
    pub basic: u32,
    pub buildtrain: u32,
    pub ability: u32,
    pub item: u32,
    pub select: u32,
    pub removeunit: u32,
    pub subgroup: u32,
    pub selecthotkey: u32,
    pub esc: u32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupHotkey {
    pub assigned: u32,
    pub used: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferResourcesActionWithPlayer {
    pub player_name: String,
    pub player_id: u8,
    pub slot: u8,
    pub gold: u32,
    pub lumber: u32,
    pub ms_elapsed: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Player {
    pub id: u8,
    pub name: String,
    pub teamid: u8,
    pub color: String,
    pub race: Race,
    #[serde(rename = "raceDetected")]
    pub race_detected: String,
    pub units: ObjectTracker,
    pub upgrades: ObjectTracker,
    pub items: ObjectTracker,
    pub buildings: ObjectTracker,
    // Local patch (see vendor/README-PATCH.md): rawcodes absent from every
    // mapping table — custom-map objects (e.g. Legion TD towers). Upstream
    // silently dropped these; they land here unclassified because the four
    // buckets above are table-driven and a foreign map's codes are in no
    // table. Omitted from JSON when empty so melee output is unchanged.
    #[serde(skip_serializing_if = "ObjectTracker::is_empty", default)]
    pub unknown: ObjectTracker,
    pub heroes: Vec<HeroInfo>,
    #[serde(skip)]
    hero_collector: FxHashMap<String, HeroCollectorInfo>,
    #[serde(skip)]
    hero_count: u32,
    pub actions: PlayerActions,
    #[serde(rename = "groupHotkeys")]
    pub group_hotkeys: HashMap<u8, GroupHotkey>,
    #[serde(rename = "resourceTransfers")]
    pub resource_transfers: Vec<TransferResourcesActionWithPlayer>,
    #[serde(skip)]
    currently_tracked_apm: u32,
    #[serde(skip)]
    last_retraining_time: u32,
    #[serde(skip)]
    pub last_action_was_deselect: bool,
    #[serde(skip)]
    pub current_time_played: u32,
    pub apm: u32,
}

impl Player {
    pub fn new(id: u8, name: String, teamid: u8, color: u8, race: Race) -> Self {
        let mut group_hotkeys = HashMap::new();
        for key in 0..=9 {
            group_hotkeys.insert(key, GroupHotkey::default());
        }

        Self {
            id,
            name,
            teamid,
            color: player_color(color).to_string(),
            race,
            race_detected: String::new(),
            units: ObjectTracker::default(),
            upgrades: ObjectTracker::default(),
            items: ObjectTracker::default(),
            buildings: ObjectTracker::default(),
            unknown: ObjectTracker::default(),
            heroes: Vec::new(),
            hero_collector: FxHashMap::default(),
            hero_count: 0,
            actions: PlayerActions::default(),
            group_hotkeys,
            resource_transfers: Vec::new(),
            currently_tracked_apm: 0,
            last_retraining_time: 0,
            last_action_was_deselect: false,
            current_time_played: 0,
            apm: 0,
        }
    }

    pub fn new_action_tracking_segment(&mut self, time_tracking_interval: u32) {
        let scaled = (self.currently_tracked_apm as f64
            * (60000.0 / f64::from(time_tracking_interval)))
        .floor() as u32;
        self.actions.timed.push(scaled);
        self.currently_tracked_apm = 0;
    }

    fn detect_race_by_action_id(&mut self, action_id: &str) {
        self.race_detected = match action_id.chars().next() {
            Some('e') => "N",
            Some('o') => "O",
            Some('h') => "H",
            Some('u') => "U",
            _ => return,
        }
        .to_string();
    }

    fn detect_race_by_order_id(&mut self, order_id: FourCC) {
        self.race_detected = match order_id[3] {
            b'e' => "N",
            b'o' => "O",
            b'h' => "H",
            b'u' => "U",
            _ => return,
        }
        .to_string();
    }

    fn handle_stringencoded_item_id(&mut self, action_id: &str, game_time: u32) {
        if unit_name(action_id).is_some() {
            self.units.push(action_id, game_time);
        } else if item_name(action_id).is_some() {
            self.items.push(action_id, game_time);
        } else if building_name(action_id).is_some() {
            self.buildings.push(action_id, game_time);
        } else if upgrade_name(action_id).is_some() {
            self.upgrades.push(action_id, game_time);
        } else {
            self.unknown.push(action_id, game_time);
        }
    }

    fn handle_stringencoded_order_id(&mut self, order_id: FourCC, game_time: u32) {
        if let Some(id) = unit_id_for_order_id(order_id) {
            self.units.push(id, game_time);
        } else if let Some(id) = item_id_for_order_id(order_id) {
            self.items.push(id, game_time);
        } else if let Some(id) = building_id_for_order_id(order_id) {
            self.buildings.push(id, game_time);
        } else if let Some(id) = upgrade_id_for_order_id(order_id) {
            self.upgrades.push(id, game_time);
        } else {
            with_order_id_str(order_id, |id| self.unknown.push(id, game_time));
        }
    }

    fn handle_hero_skill(&mut self, action_id: &str, game_time: u32) {
        let hero_id = ability_to_hero(action_id).map(ToString::to_string);
        let hero_key = hero_id
            .clone()
            .unwrap_or_else(|| "__w3gjs_undefined_hero".to_string());

        if !self.hero_collector.contains_key(&hero_key) {
            self.hero_count += 1;
            self.hero_collector.insert(
                hero_key.clone(),
                HeroCollectorInfo {
                    level: 0,
                    abilities: HashMap::new(),
                    order: self.hero_count,
                    id: hero_id,
                    ability_order: Vec::new(),
                    retraining_history: Vec::new(),
                },
            );
        }

        let hero = self
            .hero_collector
            .get_mut(&hero_key)
            .expect("inserted hero");
        hero.ability_order.push(AbilityOrderEntry::Ability {
            time: game_time,
            value: action_id.to_string(),
        });

        if self.last_retraining_time > 0 {
            if let Some(index) =
                get_retraining_index(&hero.ability_order, self.last_retraining_time)
            {
                hero.ability_order.insert(
                    index,
                    AbilityOrderEntry::Retraining {
                        time: self.last_retraining_time,
                    },
                );
                self.last_retraining_time = 0;
            }
        }
    }

    pub fn handle_retraining(&mut self, game_time: u32) {
        self.last_retraining_time = game_time;
    }

    pub fn effective_race_code(&self) -> &str {
        if self.race_detected.is_empty() {
            self.race.as_w3gjs_code()
        } else {
            self.race_detected.as_str()
        }
    }

    fn handle_0x10_stringencoded(&mut self, action_id: &str, game_time: u32) {
        match action_id.chars().next() {
            Some('A') => self.handle_hero_skill(action_id, game_time),
            Some('R') => self.handle_stringencoded_item_id(action_id, game_time),
            Some('u' | 'e' | 'h' | 'o') => {
                if self.race_detected.is_empty() {
                    self.detect_race_by_action_id(action_id);
                }
                self.handle_stringencoded_item_id(action_id, game_time);
            }
            _ => self.handle_stringencoded_item_id(action_id, game_time),
        }

        if !action_id.starts_with('0') {
            self.actions.buildtrain += 1;
        } else {
            self.actions.ability += 1;
        }
    }

    pub fn handle_0x10(&mut self, item_id: &ItemId, game_time: u32) {
        match item_id {
            ItemId::StringEncoded(action_id) => {
                self.handle_0x10_stringencoded(action_id, game_time)
            }
            ItemId::Alphanumeric(_) => self.actions.buildtrain += 1,
        }
        self.currently_tracked_apm += 1;
    }

    pub(crate) fn handle_0x10_order_id(&mut self, order_id: FourCC, game_time: u32) {
        if is_string_encoded_order_id(order_id) {
            match order_id[3] {
                b'A' => {
                    with_order_id_str(order_id, |action_id| {
                        self.handle_hero_skill(action_id, game_time);
                    });
                }
                b'u' | b'e' | b'h' | b'o' => {
                    if self.race_detected.is_empty() {
                        self.detect_race_by_order_id(order_id);
                    }
                    self.handle_stringencoded_order_id(order_id, game_time);
                }
                _ => self.handle_stringencoded_order_id(order_id, game_time),
            }
            self.actions.buildtrain += 1;
        } else {
            self.actions.buildtrain += 1;
        }
        self.currently_tracked_apm += 1;
    }

    pub fn handle_0x11(&mut self, item_id: &ItemId, game_time: u32) {
        self.currently_tracked_apm += 1;
        match item_id {
            ItemId::Alphanumeric(value) => {
                if is_basic_action(value) {
                    self.actions.basic += 1;
                } else {
                    self.actions.ability += 1;
                }
            }
            ItemId::StringEncoded(value) => self.handle_stringencoded_item_id(value, game_time),
        }
    }

    pub(crate) fn handle_0x11_order_id(&mut self, order_id: FourCC, game_time: u32) {
        self.currently_tracked_apm += 1;
        if is_string_encoded_order_id(order_id) {
            self.handle_stringencoded_order_id(order_id, game_time);
        } else if is_basic_action(&order_id) {
            self.actions.basic += 1;
        } else {
            self.actions.ability += 1;
        }
    }

    pub fn handle_0x12(&mut self, item_id: &ItemId, game_time: u32) {
        match item_id {
            ItemId::Alphanumeric(value) if is_rightclick_action(value) => {
                self.actions.rightclick += 1
            }
            ItemId::Alphanumeric(value) if is_basic_action(value) => self.actions.basic += 1,
            _ => self.actions.ability += 1,
        }

        if let ItemId::StringEncoded(value) = item_id {
            self.handle_stringencoded_item_id(value, game_time);
        }
        self.currently_tracked_apm += 1;
    }

    pub(crate) fn handle_0x12_order_id(&mut self, order_id: FourCC, game_time: u32) {
        if is_string_encoded_order_id(order_id) {
            self.actions.ability += 1;
            self.handle_stringencoded_order_id(order_id, game_time);
        } else if is_rightclick_action(&order_id) {
            self.actions.rightclick += 1;
        } else if is_basic_action(&order_id) {
            self.actions.basic += 1;
        } else {
            self.actions.ability += 1;
        }
        self.currently_tracked_apm += 1;
    }

    pub fn handle_0x13(&mut self) {
        self.actions.item += 1;
        self.currently_tracked_apm += 1;
    }

    pub fn handle_0x14(&mut self, item_id: &ItemId) {
        match item_id {
            ItemId::Alphanumeric(value) if is_rightclick_action(value) => {
                self.actions.rightclick += 1
            }
            ItemId::Alphanumeric(value) if is_basic_action(value) => self.actions.basic += 1,
            _ => self.actions.ability += 1,
        }
        self.currently_tracked_apm += 1;
    }

    pub(crate) fn handle_0x14_order_id(&mut self, order_id: FourCC) {
        if !is_string_encoded_order_id(order_id) && is_rightclick_action(&order_id) {
            self.actions.rightclick += 1;
        } else if !is_string_encoded_order_id(order_id) && is_basic_action(&order_id) {
            self.actions.basic += 1;
        } else {
            self.actions.ability += 1;
        }
        self.currently_tracked_apm += 1;
    }

    pub fn handle_0x16(&mut self, is_apm: bool) {
        if is_apm {
            self.actions.select += 1;
            self.currently_tracked_apm += 1;
        }
    }

    pub fn handle_0x51(
        &mut self,
        slot: u8,
        gold: u32,
        lumber: u32,
        player_id: u8,
        player_name: String,
    ) {
        self.resource_transfers
            .push(TransferResourcesActionWithPlayer {
                slot,
                gold,
                lumber,
                player_id,
                player_name,
                ms_elapsed: self.current_time_played,
            });
    }

    pub(crate) fn handle_assign_group_hotkey(&mut self, group_number: u8) {
        self.actions.assigngroup += 1;
        self.currently_tracked_apm += 1;
        self.group_hotkeys
            .entry((group_number + 1) % 10)
            .or_default()
            .assigned += 1;
    }

    pub(crate) fn handle_select_group_hotkey(&mut self, group_number: u8) {
        self.actions.selecthotkey += 1;
        self.currently_tracked_apm += 1;
        self.group_hotkeys
            .entry((group_number + 1) % 10)
            .or_default()
            .used += 1;
    }

    pub(crate) fn handle_misc_apm_action(&mut self) {
        self.currently_tracked_apm += 1;
    }

    pub(crate) fn handle_remove_unit_from_building_queue(&mut self) {
        self.actions.removeunit += 1;
        self.currently_tracked_apm += 1;
    }

    pub(crate) fn handle_esc_pressed(&mut self) {
        self.actions.esc += 1;
        self.currently_tracked_apm += 1;
    }

    pub fn handle_other(&mut self, action: &Action) {
        match action {
            Action::AssignGroupHotkey { group_number, .. } => {
                self.handle_assign_group_hotkey(*group_number);
            }
            Action::SelectGroupHotkey { group_number } => {
                self.handle_select_group_hotkey(*group_number);
            }
            Action::SelectGroundItem { .. }
            | Action::CancelHeroRevival { .. }
            | Action::ChooseHeroSkillSubmenu
            | Action::EnterBuildingSubmenu => {
                self.handle_misc_apm_action();
            }
            Action::RemoveUnitFromBuildingQueue { .. } => {
                self.handle_remove_unit_from_building_queue();
            }
            Action::EscPressed => {
                self.handle_esc_pressed();
            }
            _ => {}
        }
    }

    pub fn determine_hero_levels_and_handle_retrainings(&mut self) {
        let mut heroes = self.hero_collector.values_mut().collect::<Vec<_>>();
        heroes.sort_by_key(|hero| hero.order);

        self.heroes = heroes
            .into_iter()
            .map(|hero| {
                let inferred = infer_hero_ability_levels_from_ability_order(&hero.ability_order);
                hero.abilities = inferred.final_hero_abilities;
                hero.retraining_history = inferred.retraining_history;
                hero.level = hero.abilities.values().sum();
                HeroInfo {
                    level: hero.level,
                    abilities: hero.abilities.clone(),
                    id: hero.id.clone(),
                    retraining_history: hero.retraining_history.clone(),
                    ability_order: hero.ability_order.clone(),
                }
            })
            .collect();
    }

    pub fn cleanup(&mut self) {
        let apm_sum: u32 = self.actions.timed.iter().sum();
        if self.current_time_played == 0 {
            self.apm = 0;
        } else {
            self.apm = (f64::from(apm_sum) / (f64::from(self.current_time_played) / 1000.0 / 60.0))
                .round() as u32;
        }
        self.determine_hero_levels_and_handle_retrainings();
    }
}

impl SortablePlayer for Player {
    fn team_id(&self) -> u8 {
        self.teamid
    }

    fn id(&self) -> u8 {
        self.id
    }
}

fn is_rightclick_action(input: &[u8]) -> bool {
    input.first() == Some(&0x03) && input.get(1) == Some(&0)
}

fn is_basic_action(input: &[u8]) -> bool {
    input.first().copied().unwrap_or(u8::MAX) <= 0x19 && input.get(1) == Some(&0)
}

fn is_string_encoded_order_id(order_id: FourCC) -> bool {
    (0x41..=0x7a).contains(&order_id[3])
}

fn string_encoded_order_id_bytes(order_id: FourCC) -> FourCC {
    [order_id[3], order_id[2], order_id[1], order_id[0]]
}

fn order_id_string(order_id: FourCC) -> String {
    string_encoded_order_id_bytes(order_id)
        .iter()
        .map(|byte| *byte as char)
        .collect()
}

fn with_order_id_str<T>(order_id: FourCC, callback: impl FnOnce(&str) -> T) -> T {
    let bytes = string_encoded_order_id_bytes(order_id);
    match std::str::from_utf8(&bytes) {
        Ok(value) => callback(value),
        Err(_) => {
            let value = order_id_string(order_id);
            callback(&value)
        }
    }
}

pub fn formatted_order_id(order_id: [u8; 4]) -> ItemId {
    object_id_formatter(order_id)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn preserves_unknown_hero_skill_without_id() {
        let mut player = Player::new(1, "Player".to_string(), 0, 0, Race::Human);

        player.handle_0x10(&ItemId::StringEncoded("Aamk".to_string()), 1234);
        player.cleanup();

        assert_eq!(player.heroes.len(), 1);
        assert_eq!(player.heroes[0].id, None);
        assert_eq!(player.heroes[0].abilities.get("Aamk"), Some(&1));

        let value = serde_json::to_value(&player.heroes[0]).unwrap();
        assert!(value.get("id").is_none());
        assert_eq!(
            value["abilityOrder"][0],
            json!({
                "type": "ability",
                "time": 1234,
                "value": "Aamk",
            })
        );
    }
}
