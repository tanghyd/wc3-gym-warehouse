//! High-level replay parser port.

use std::{path::Path, time::Instant};

use rustc_hash::{FxHashMap, FxHashSet};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    Error, Result,
    action::{Action, FourCC},
    buffer::to_hex,
    convert::{game_version, map_filename},
    formatters::race_flag_formatter,
    game_data::{
        CommandBlock, GameDataBlock, GameDataSummaryStats, GameDataSummaryVisitor, LeaveGameBlock,
        PlayerChatMessageBlock, TimeslotBlock,
    },
    metadata::{MetadataParser, PlayerRecord, ReplayMetadata},
    player::Player,
    raw::{RawParser, SubHeader, get_uncompressed_borrowed_data},
    replay_parser::{ReplayParser, ReplayParserOutput, ReplayParserSummaryPrefix},
    sort::sort_players,
};

#[derive(Debug)]
pub struct W3GReplay {
    parser: ReplayParser,
    context: Option<ReplayContext>,
    players: FxHashMap<u8, Player>,
    observers: Vec<String>,
    chatlog: Vec<ChatMessage>,
    id: String,
    leave_events: Vec<LeaveGameBlock>,
    total_time_tracker: u32,
    time_segment_tracker: u32,
    player_action_track_interval: u32,
    game_type: String,
    matchup: String,
    slot_to_player_id: [u8; 256],
    known_player_ids: [bool; 256],
    winning_team_id: i16,
    is_parsing: bool,
}

#[derive(Debug)]
struct ReplayContext {
    subheader: SubHeader,
    metadata: ReplayMetadata,
}

impl W3GReplay {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_parsing(&self) -> bool {
        self.is_parsing
    }

    pub fn parse_file(&mut self, path: impl AsRef<Path>) -> Result<ParserOutput> {
        let bytes = std::fs::read(path)?;
        self.parse_bytes(&bytes)
    }

    pub fn parse_file_detailed(&mut self, path: impl AsRef<Path>) -> Result<ParsedReplay> {
        let bytes = std::fs::read(path)?;
        self.parse_bytes_detailed(&bytes)
    }

    pub fn parse_bytes(&mut self, bytes: &[u8]) -> Result<ParserOutput> {
        self.parse_bytes_summary(bytes, None)
    }

    #[doc(hidden)]
    pub fn parse_bytes_with_phases(&mut self, bytes: &[u8]) -> Result<PhasedParserOutput> {
        let mut phases = ParsePhaseTimings::default();
        let output = self.parse_bytes_summary(bytes, Some(&mut phases))?;

        Ok(PhasedParserOutput { output, phases })
    }

    fn parse_bytes_summary(
        &mut self,
        bytes: &[u8],
        mut phases: Option<&mut ParsePhaseTimings>,
    ) -> Result<ParserOutput> {
        if self.is_parsing {
            return Err(Error::ConcurrentParsingNotSupported);
        }

        self.is_parsing = true;
        let parse_start = Instant::now();
        let result = (|| {
            self.reset_state();
            let parser = ReplayParser::new();
            let prefix = if let Some(phases) = phases.as_deref_mut() {
                Self::parse_summary_prefix_with_phases(bytes, phases)?
            } else {
                parser.parse_summary_prefix(bytes)?
            };

            let started = Instant::now();
            self.handle_basic_replay_information(&prefix.metadata);
            if let Some(phases) = phases.as_deref_mut() {
                phases.setup_ms = elapsed_ms(started);
            }

            let started = Instant::now();
            if let Some(phases) = phases.as_deref_mut() {
                let mut stats = GameDataSummaryStats::default();
                parser.parse_summary_game_data_slice_with_stats(
                    &prefix.decompressed_data[prefix.game_data_offset..],
                    prefix.metadata.is_post_202_replay_format,
                    self,
                    &mut stats,
                )?;
                phases.game_data_blocks = stats.blocks;
                phases.game_data_ignored_blocks = stats.ignored_blocks;
                phases.game_data_timeslots = stats.timeslots;
                phases.game_data_command_blocks = stats.command_blocks;
                phases.game_data_skipped_command_blocks = stats.skipped_command_blocks;
                phases.game_data_action_bytes = stats.action_bytes;
                phases.game_data_skipped_action_bytes = stats.skipped_action_bytes;
                phases.game_data_actions = stats.actions;
                phases.game_data_summary_actions = stats.summary_actions;
                phases.game_data_ignored_actions = stats.ignored_actions;
                phases.game_data_chat_messages = stats.chat_messages;
                phases.game_data_leave_game_blocks = stats.leave_game_blocks;
            } else {
                parser.parse_summary_game_data_slice_with(
                    &prefix.decompressed_data[prefix.game_data_offset..],
                    prefix.metadata.is_post_202_replay_format,
                    self,
                )?;
            }
            if let Some(phases) = phases.as_deref_mut() {
                phases.game_data_ms = elapsed_ms(started);
            }

            let started = Instant::now();
            self.set_context(prefix.subheader, prefix.metadata);
            self.generate_id();
            self.determine_matchup();
            self.determine_winning_team();
            self.cleanup();
            if let Some(phases) = phases.as_deref_mut() {
                phases.postprocess_ms = elapsed_ms(started);
            }

            let started = Instant::now();
            let output = self.finalize(parse_start)?;
            if let Some(phases) = phases.as_deref_mut() {
                phases.finalize_ms = elapsed_ms(started);
                phases.total_ms = elapsed_ms(parse_start);
            }

            Ok(output)
        })();
        self.is_parsing = false;
        result
    }

    fn parse_summary_prefix_with_phases(
        bytes: &[u8],
        phases: &mut ParsePhaseTimings,
    ) -> Result<ReplayParserSummaryPrefix> {
        let raw_parser = RawParser::new();
        let metadata_parser = MetadataParser::new();

        let started = Instant::now();
        let raw = raw_parser.parse_borrowed(bytes)?;
        phases.raw_ms = elapsed_ms(started);

        let started = Instant::now();
        let decompressed_data = get_uncompressed_borrowed_data(&raw.blocks)?;
        phases.decompress_ms = elapsed_ms(started);

        let started = Instant::now();
        let metadata_parts = metadata_parser.parse_data_without_game_data(&decompressed_data)?;
        phases.metadata_ms = elapsed_ms(started);

        Ok(ReplayParserSummaryPrefix {
            header: raw.header,
            subheader: raw.subheader,
            metadata: metadata_parts.metadata,
            decompressed_data,
            game_data_offset: metadata_parts.game_data_offset,
        })
    }

    pub fn parse_bytes_detailed(&mut self, bytes: &[u8]) -> Result<ParsedReplay> {
        if self.is_parsing {
            return Err(Error::ConcurrentParsingNotSupported);
        }

        self.is_parsing = true;
        let parse_start = Instant::now();
        let result = (|| {
            self.reset_state();
            let info = self.parser.parse(bytes)?;
            self.handle_basic_replay_information(&info.metadata);

            for block in &info.game_data_blocks {
                self.process_game_data_block(block);
            }

            self.set_context_from_metadata(info.subheader.clone(), &info.metadata);
            self.generate_id();
            self.determine_matchup();
            self.determine_winning_team();
            self.cleanup();
            let summary = self.finalize(parse_start)?;
            Ok(ParsedReplay {
                low_level: info,
                summary,
            })
        })();
        self.is_parsing = false;
        result
    }

    fn reset_state(&mut self) {
        self.context = None;
        self.players.clear();
        self.observers.clear();
        self.chatlog.clear();
        self.id.clear();
        self.leave_events.clear();
        self.total_time_tracker = 0;
        self.time_segment_tracker = 0;
        self.player_action_track_interval = 60000;
        self.game_type.clear();
        self.matchup.clear();
        self.slot_to_player_id = [0; 256];
        self.known_player_ids = [false; 256];
        self.winning_team_id = -1;
    }

    fn set_context(&mut self, subheader: SubHeader, mut metadata: ReplayMetadata) {
        metadata.game_data = Vec::new();
        self.context = Some(ReplayContext {
            subheader,
            metadata,
        });
    }

    fn set_context_from_metadata(&mut self, subheader: SubHeader, metadata: &ReplayMetadata) {
        self.context = Some(ReplayContext {
            subheader,
            metadata: clone_metadata_without_game_data(metadata),
        });
    }

    fn handle_basic_replay_information(&mut self, metadata: &ReplayMetadata) {
        let mut temp_players: FxHashMap<u8, PlayerRecord> = FxHashMap::default();
        for player in &metadata.player_records {
            temp_players.insert(player.player_id, player.clone());
        }

        for extra_player in &metadata.reforged_player_metadata {
            if let Some(player) = temp_players.get_mut(&(extra_player.player_id as u8)) {
                player.player_name = extra_player.name.clone();
            }
        }

        for (index, slot) in metadata.slot_records.iter().enumerate() {
            if slot.slot_status > 1 {
                if let Some(player_id) = self.slot_to_player_id.get_mut(index) {
                    *player_id = slot.player_id;
                }

                let name = temp_players
                    .get(&slot.player_id)
                    .map(|player| player.player_name.clone())
                    .unwrap_or_else(|| "Computer".to_string());
                self.players.insert(
                    slot.player_id,
                    Player::new(
                        slot.player_id,
                        name,
                        slot.team_id,
                        slot.color,
                        race_flag_formatter(slot.race_flag),
                    ),
                );
            }
        }

        self.known_player_ids = [false; 256];
        for player_id in self.players.keys().copied() {
            self.known_player_ids[usize::from(player_id)] = true;
        }
    }

    fn process_game_data_block(&mut self, block: &GameDataBlock) {
        match block {
            GameDataBlock::Timeslot(timeslot) => {
                self.total_time_tracker += u32::from(timeslot.time_increment);
                self.time_segment_tracker += u32::from(timeslot.time_increment);
                if self.time_segment_tracker > self.player_action_track_interval {
                    for player in self.players.values_mut() {
                        player.new_action_tracking_segment(self.player_action_track_interval);
                    }
                    self.time_segment_tracker = 0;
                }
                self.handle_timeslot(timeslot);
            }
            GameDataBlock::PlayerChatMessage(chat) => {
                self.handle_chat_message(chat, self.total_time_tracker);
            }
            GameDataBlock::LeaveGame(leave) => self.leave_events.push(leave.clone()),
        }
    }

    fn handle_timeslot(&mut self, block: &TimeslotBlock) {
        for command_block in &block.command_blocks {
            self.process_command_data_block(command_block);
        }
    }

    fn process_command_data_block(&mut self, block: &CommandBlock) {
        if !self.known_player_ids[usize::from(block.player_id)] {
            return;
        }

        if let Some(player) = self.players.get_mut(&block.player_id) {
            player.current_time_played = self.total_time_tracker;
            player.last_action_was_deselect = false;
        }

        for action in &block.actions {
            self.handle_action_block(action, block.player_id);
        }
    }

    fn handle_action_block(&mut self, action: &Action, current_player_id: u8) {
        match action {
            Action::TransferResources { slot, gold, lumber } => {
                let player_id = self.slot_to_player_id[usize::from(*slot)];
                if player_id != 0 {
                    let player_name = self
                        .players
                        .get(&player_id)
                        .map(|player| player.name.clone())
                        .unwrap_or_default();
                    if let Some(current_player) = self.players.get_mut(&current_player_id) {
                        current_player.handle_0x51(*slot, *gold, *lumber, player_id, player_name);
                    }
                }
            }
            Action::BlzCacheStoreInt { .. } => {}
            _ => {
                if let Some(current_player) = self.players.get_mut(&current_player_id) {
                    handle_action_for_player(action, current_player, self.total_time_tracker);
                }
            }
        }
    }

    fn handle_chat_message(&mut self, block: &PlayerChatMessageBlock, time_ms: u32) {
        let Some(player) = self.players.get(&block.player_id) else {
            return;
        };
        self.chatlog.push(ChatMessage {
            player_name: player.name.clone(),
            player_id: block.player_id,
            mode: numerical_chat_mode_to_chat_message_mode(block.mode),
            time_ms,
            message: block.message.clone(),
        });
    }

    fn determine_winning_team(&mut self) {
        if self.game_type != "1on1" {
            return;
        }

        let non_obs_players = self
            .players
            .values()
            .filter(|player| !self.is_observer(player))
            .cloned()
            .collect::<Vec<_>>();
        let non_obs_player_ids = non_obs_players
            .iter()
            .map(|player| player.id)
            .collect::<FxHashSet<_>>();
        let non_obs_leaves = self
            .leave_events
            .iter()
            .filter(|event| non_obs_player_ids.contains(&event.player_id))
            .cloned()
            .collect::<Vec<_>>();

        if let Some(victory_leave) = non_obs_leaves
            .iter()
            .find(|event| event.result == "09000000")
        {
            if let Some(player) = self.players.get(&victory_leave.player_id) {
                self.winning_team_id = i16::from(player.teamid);
            }
            return;
        }

        if let Some(game_over_leave) = non_obs_leaves
            .iter()
            .find(|event| event.reason == "0c000000")
        {
            if let Some(player) = self.players.get(&game_over_leave.player_id) {
                self.winning_team_id = i16::from(player.teamid);
            }
            return;
        }

        if let Some(first_leave) = non_obs_leaves.first() {
            if let Some(loser) = self.players.get(&first_leave.player_id) {
                let loser_team_id = loser.teamid;
                if let Some(winner) = non_obs_players
                    .iter()
                    .find(|player| player.teamid != loser_team_id)
                {
                    self.winning_team_id = i16::from(winner.teamid);
                }
            }
        }
    }

    fn is_observer(&self, player: &Player) -> bool {
        let Some(context) = &self.context else {
            return false;
        };
        (player.teamid == 24 && context.subheader.version >= 29)
            || (player.teamid == 12 && context.subheader.version < 29)
    }

    fn determine_matchup(&mut self) {
        let mut team_races: FxHashMap<u8, Vec<String>> = FxHashMap::default();
        for player in self.players.values() {
            if !self.is_observer(player) {
                let race = player.effective_race_code().to_string();
                team_races.entry(player.teamid).or_default().push(race);
            }
        }

        let mut lengths = team_races
            .values()
            .map(|races| races.len().to_string())
            .collect::<Vec<_>>();
        lengths.sort();
        self.game_type = lengths.join("on");

        let mut matchup = team_races
            .values_mut()
            .map(|races| {
                races.sort();
                races.join("")
            })
            .collect::<Vec<_>>();
        matchup.sort();
        self.matchup = matchup.join("v");
    }

    fn generate_id(&mut self) {
        let Some(context) = &self.context else {
            return;
        };
        let meta = &context.metadata;

        let mut players = self
            .players
            .values()
            .filter(|player| !self.is_observer(player))
            .collect::<Vec<_>>();
        players.sort_by_key(|player| player.id);
        let player_names = players
            .into_iter()
            .map(|player| player.name.as_str())
            .collect::<String>();

        let id_base = format!("{}{}{}", meta.random_seed, player_names, meta.game_name);
        self.id = to_hex(&Sha256::digest(id_base.as_bytes()));
    }

    fn cleanup(&mut self) {
        let observer_ids = self
            .players
            .values()
            .filter(|player| self.is_observer(player))
            .map(|player| player.id)
            .collect::<Vec<_>>();
        let mut observer_ids = observer_ids;
        observer_ids.sort_unstable();

        for player in self.players.values_mut() {
            player.new_action_tracking_segment(self.player_action_track_interval);
            player.cleanup();
        }

        for observer_id in observer_ids {
            if let Some(player) = self.players.remove(&observer_id) {
                self.observers.push(player.name);
            }
        }
    }

    fn finalize(&mut self, parse_start: Instant) -> Result<ParserOutput> {
        let (
            game_name,
            random_seed,
            start_spots,
            creator,
            map,
            build_number,
            version,
            duration,
            expansion,
            settings,
        ) = {
            let context = self
                .context
                .as_ref()
                .ok_or_else(|| Error::Message("missing replay context".to_string()))?;
            let meta = &context.metadata;
            let map_path = meta.map.map_name.clone();
            let settings = ReplaySettings {
                referees: meta.map.referees,
                observer_mode: get_observer_mode(meta.map.referees, meta.map.observer_mode),
                fixed_teams: meta.map.fixed_teams,
                full_shared_unit_control: meta.map.full_shared_unit_control,
                always_visible: meta.map.always_visible,
                hide_terrain: meta.map.hide_terrain,
                map_explored: meta.map.map_explored,
                teams_together: meta.map.teams_together,
                random_hero: meta.map.random_hero,
                random_races: meta.map.random_races,
                speed: meta.map.speed,
            };
            let map = ReplayMap {
                file: map_filename(&map_path),
                path: map_path,
                checksum: meta.map.map_checksum.clone(),
                checksum_sha1: meta.map.map_checksum_sha1.clone(),
            };

            (
                meta.game_name.clone(),
                meta.random_seed,
                meta.start_spot_count,
                meta.map.creator.clone(),
                map,
                context.subheader.build_no,
                game_version(context.subheader.version),
                context.subheader.replay_length_ms,
                context.subheader.game_identifier == "PX3W",
                settings,
            )
        };

        let mut players = std::mem::take(&mut self.players)
            .into_values()
            .collect::<Vec<_>>();
        players.sort_by(sort_players);

        Ok(ParserOutput {
            id: std::mem::take(&mut self.id),
            game_name,
            random_seed,
            start_spots,
            observers: std::mem::take(&mut self.observers),
            players,
            matchup: std::mem::take(&mut self.matchup),
            creator,
            game_type: std::mem::take(&mut self.game_type),
            chat: std::mem::take(&mut self.chatlog),
            apm: ApmSettings {
                tracking_interval: self.player_action_track_interval,
            },
            map,
            build_number,
            version,
            duration,
            expansion,
            parse_time: parse_start.elapsed().as_millis() as u64,
            winning_team_id: self.winning_team_id,
            settings,
        })
    }
}

impl GameDataSummaryVisitor for W3GReplay {
    fn handle_time_increment(&mut self, time_increment: u16) -> Result<()> {
        self.total_time_tracker += u32::from(time_increment);
        self.time_segment_tracker += u32::from(time_increment);
        if self.time_segment_tracker > self.player_action_track_interval {
            for player in self.players.values_mut() {
                player.new_action_tracking_segment(self.player_action_track_interval);
            }
            self.time_segment_tracker = 0;
        }
        Ok(())
    }

    fn begin_command_block(&mut self, player_id: u8) -> Result<bool> {
        if !self.known_player_ids[usize::from(player_id)] {
            return Ok(false);
        }

        if let Some(player) = self.players.get_mut(&player_id) {
            player.current_time_played = self.total_time_tracker;
            player.last_action_was_deselect = false;
        }

        Ok(true)
    }

    fn unit_building_ability_no_params(&mut self, player_id: u8, order_id: FourCC) -> Result<()> {
        if let Some(current_player) = self.players.get_mut(&player_id) {
            if is_retraining_order_id(order_id) {
                current_player.handle_retraining(self.total_time_tracker);
            }
            current_player.handle_0x10_order_id(order_id, self.total_time_tracker);
        }
        Ok(())
    }

    fn unit_building_ability_target_position(
        &mut self,
        player_id: u8,
        order_id: FourCC,
    ) -> Result<()> {
        if let Some(current_player) = self.players.get_mut(&player_id) {
            current_player.handle_0x11_order_id(order_id, self.total_time_tracker);
        }
        Ok(())
    }

    fn unit_building_ability_target_position_object(
        &mut self,
        player_id: u8,
        order_id: FourCC,
    ) -> Result<()> {
        if let Some(current_player) = self.players.get_mut(&player_id) {
            current_player.handle_0x12_order_id(order_id, self.total_time_tracker);
        }
        Ok(())
    }

    fn give_item_to_unit(&mut self, player_id: u8) -> Result<()> {
        if let Some(current_player) = self.players.get_mut(&player_id) {
            current_player.handle_0x13();
        }
        Ok(())
    }

    fn unit_building_ability_two_target_positions(
        &mut self,
        player_id: u8,
        order_id1: FourCC,
    ) -> Result<()> {
        if let Some(current_player) = self.players.get_mut(&player_id) {
            current_player.handle_0x14_order_id(order_id1);
        }
        Ok(())
    }

    fn change_selection(&mut self, player_id: u8, select_mode: u8) -> Result<()> {
        if let Some(current_player) = self.players.get_mut(&player_id) {
            if select_mode == 0x02 {
                current_player.last_action_was_deselect = true;
                current_player.handle_0x16(true);
            } else {
                if !current_player.last_action_was_deselect {
                    current_player.handle_0x16(true);
                }
                current_player.last_action_was_deselect = false;
            }
        }
        Ok(())
    }

    fn assign_group_hotkey(&mut self, player_id: u8, group_number: u8) -> Result<()> {
        if let Some(current_player) = self.players.get_mut(&player_id) {
            current_player.handle_assign_group_hotkey(group_number);
        }
        Ok(())
    }

    fn select_group_hotkey(&mut self, player_id: u8, group_number: u8) -> Result<()> {
        if let Some(current_player) = self.players.get_mut(&player_id) {
            current_player.handle_select_group_hotkey(group_number);
        }
        Ok(())
    }

    fn select_ground_item(&mut self, player_id: u8) -> Result<()> {
        if let Some(current_player) = self.players.get_mut(&player_id) {
            current_player.handle_misc_apm_action();
        }
        Ok(())
    }

    fn cancel_hero_revival(&mut self, player_id: u8) -> Result<()> {
        if let Some(current_player) = self.players.get_mut(&player_id) {
            current_player.handle_misc_apm_action();
        }
        Ok(())
    }

    fn remove_unit_from_building_queue(&mut self, player_id: u8) -> Result<()> {
        if let Some(current_player) = self.players.get_mut(&player_id) {
            current_player.handle_remove_unit_from_building_queue();
        }
        Ok(())
    }

    fn transfer_resources(
        &mut self,
        current_player_id: u8,
        slot: u8,
        gold: u32,
        lumber: u32,
    ) -> Result<()> {
        let player_id = self.slot_to_player_id[usize::from(slot)];
        if player_id != 0 {
            let player_name = self
                .players
                .get(&player_id)
                .map(|player| player.name.clone())
                .unwrap_or_default();
            if let Some(current_player) = self.players.get_mut(&current_player_id) {
                current_player.handle_0x51(slot, gold, lumber, player_id, player_name);
            }
        }
        Ok(())
    }

    fn esc_pressed(&mut self, player_id: u8) -> Result<()> {
        if let Some(current_player) = self.players.get_mut(&player_id) {
            current_player.handle_esc_pressed();
        }
        Ok(())
    }

    fn choose_hero_skill_submenu(&mut self, player_id: u8) -> Result<()> {
        if let Some(current_player) = self.players.get_mut(&player_id) {
            current_player.handle_misc_apm_action();
        }
        Ok(())
    }

    fn enter_building_submenu(&mut self, player_id: u8) -> Result<()> {
        if let Some(current_player) = self.players.get_mut(&player_id) {
            current_player.handle_misc_apm_action();
        }
        Ok(())
    }

    fn handle_chat_message(&mut self, chat: PlayerChatMessageBlock) -> Result<()> {
        W3GReplay::handle_chat_message(self, &chat, self.total_time_tracker);
        Ok(())
    }

    fn handle_leave_game(&mut self, leave: LeaveGameBlock) -> Result<()> {
        self.leave_events.push(leave);
        Ok(())
    }
}

fn clone_metadata_without_game_data(metadata: &ReplayMetadata) -> ReplayMetadata {
    ReplayMetadata {
        game_data: Vec::new(),
        map: metadata.map.clone(),
        player_count: metadata.player_count,
        game_type: metadata.game_type.clone(),
        locale_hash: metadata.locale_hash.clone(),
        player_records: metadata.player_records.clone(),
        slot_records: metadata.slot_records.clone(),
        reforged_player_metadata: metadata.reforged_player_metadata.clone(),
        random_seed: metadata.random_seed,
        select_mode: metadata.select_mode.clone(),
        game_name: metadata.game_name.clone(),
        start_spot_count: metadata.start_spot_count,
        is_post_202_replay_format: metadata.is_post_202_replay_format,
    }
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

impl Default for W3GReplay {
    fn default() -> Self {
        Self {
            parser: ReplayParser::new(),
            context: None,
            players: FxHashMap::default(),
            observers: Vec::new(),
            chatlog: Vec::new(),
            id: String::new(),
            leave_events: Vec::new(),
            total_time_tracker: 0,
            time_segment_tracker: 0,
            player_action_track_interval: 60000,
            game_type: String::new(),
            matchup: String::new(),
            slot_to_player_id: [0; 256],
            known_player_ids: [false; 256],
            winning_team_id: -1,
            is_parsing: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedReplay {
    pub low_level: ReplayParserOutput,
    pub summary: ParserOutput,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[doc(hidden)]
pub struct PhasedParserOutput {
    pub output: ParserOutput,
    pub phases: ParsePhaseTimings,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[doc(hidden)]
pub struct ParsePhaseTimings {
    pub raw_ms: f64,
    pub decompress_ms: f64,
    pub metadata_ms: f64,
    pub setup_ms: f64,
    pub game_data_ms: f64,
    pub postprocess_ms: f64,
    pub finalize_ms: f64,
    pub total_ms: f64,
    pub game_data_blocks: u64,
    pub game_data_ignored_blocks: u64,
    pub game_data_timeslots: u64,
    pub game_data_command_blocks: u64,
    pub game_data_skipped_command_blocks: u64,
    pub game_data_action_bytes: u64,
    pub game_data_skipped_action_bytes: u64,
    pub game_data_actions: u64,
    pub game_data_summary_actions: u64,
    pub game_data_ignored_actions: u64,
    pub game_data_chat_messages: u64,
    pub game_data_leave_game_blocks: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParserOutput {
    pub id: String,
    #[serde(rename = "gamename")]
    pub game_name: String,
    #[serde(rename = "randomseed")]
    pub random_seed: u32,
    #[serde(rename = "startSpots")]
    pub start_spots: u8,
    pub observers: Vec<String>,
    pub players: Vec<Player>,
    pub matchup: String,
    pub creator: String,
    #[serde(rename = "type")]
    pub game_type: String,
    pub chat: Vec<ChatMessage>,
    pub apm: ApmSettings,
    pub map: ReplayMap,
    #[serde(rename = "buildNumber")]
    pub build_number: u16,
    pub version: String,
    pub duration: u32,
    pub expansion: bool,
    #[serde(rename = "parseTime")]
    pub parse_time: u64,
    #[serde(rename = "winningTeamId")]
    pub winning_team_id: i16,
    pub settings: ReplaySettings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApmSettings {
    #[serde(rename = "trackingInterval")]
    pub tracking_interval: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplayMap {
    pub path: String,
    pub file: String,
    pub checksum: String,
    #[serde(rename = "checksumSha1")]
    pub checksum_sha1: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplaySettings {
    pub referees: bool,
    #[serde(rename = "observerMode")]
    pub observer_mode: ObserverMode,
    #[serde(rename = "fixedTeams")]
    pub fixed_teams: bool,
    #[serde(rename = "fullSharedUnitControl")]
    pub full_shared_unit_control: bool,
    #[serde(rename = "alwaysVisible")]
    pub always_visible: bool,
    #[serde(rename = "hideTerrain")]
    pub hide_terrain: bool,
    #[serde(rename = "mapExplored")]
    pub map_explored: bool,
    #[serde(rename = "teamsTogether")]
    pub teams_together: bool,
    #[serde(rename = "randomHero")]
    pub random_hero: bool,
    #[serde(rename = "randomRaces")]
    pub random_races: bool,
    pub speed: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ObserverMode {
    #[serde(rename = "ON_DEFEAT")]
    OnDefeat,
    #[serde(rename = "FULL")]
    Full,
    #[serde(rename = "REFEREES")]
    Referees,
    #[serde(rename = "NONE")]
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    #[serde(rename = "playerName")]
    pub player_name: String,
    #[serde(rename = "playerId")]
    pub player_id: u8,
    pub mode: ChatMessageMode,
    #[serde(rename = "timeMS")]
    pub time_ms: u32,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChatMessageMode {
    #[serde(rename = "All")]
    All,
    #[serde(rename = "Private")]
    Private,
    #[serde(rename = "Team")]
    Team,
    #[serde(rename = "Obervers")]
    Observers,
}

fn numerical_chat_mode_to_chat_message_mode(number: u32) -> ChatMessageMode {
    match number {
        0x00 => ChatMessageMode::All,
        0x01 => ChatMessageMode::Team,
        0x02 => ChatMessageMode::Observers,
        _ => ChatMessageMode::Private,
    }
}

fn get_observer_mode(referee_flag: bool, observer_mode: u8) -> ObserverMode {
    if (observer_mode == 3 || observer_mode == 0) && referee_flag {
        ObserverMode::Referees
    } else if observer_mode == 2 {
        ObserverMode::OnDefeat
    } else if observer_mode == 3 {
        ObserverMode::Full
    } else {
        ObserverMode::None
    }
}

fn handle_action_for_player(action: &Action, current_player: &mut Player, total_time_tracker: u32) {
    match action {
        Action::UnitBuildingAbilityNoParams { order_id, .. } => {
            if is_retraining_order_id(*order_id) {
                current_player.handle_retraining(total_time_tracker);
            }
            current_player.handle_0x10_order_id(*order_id, total_time_tracker);
        }
        Action::UnitBuildingAbilityTargetPosition { order_id, .. } => {
            current_player.handle_0x11_order_id(*order_id, total_time_tracker);
        }
        Action::UnitBuildingAbilityTargetPositionObject { order_id, .. } => {
            current_player.handle_0x12_order_id(*order_id, total_time_tracker);
        }
        Action::GiveItemToUnit { .. } => current_player.handle_0x13(),
        Action::UnitBuildingAbilityTwoTargetPositions { order_id1, .. } => {
            current_player.handle_0x14_order_id(*order_id1);
        }
        Action::ChangeSelection { select_mode, .. } => {
            if *select_mode == 0x02 {
                current_player.last_action_was_deselect = true;
                current_player.handle_0x16(true);
            } else {
                if !current_player.last_action_was_deselect {
                    current_player.handle_0x16(true);
                }
                current_player.last_action_was_deselect = false;
            }
        }
        Action::AssignGroupHotkey { .. }
        | Action::SelectGroupHotkey { .. }
        | Action::SelectGroundItem { .. }
        | Action::CancelHeroRevival { .. }
        | Action::RemoveUnitFromBuildingQueue { .. }
        | Action::EscPressed
        | Action::TrackableTrack { .. }
        | Action::ChooseHeroSkillSubmenu
        | Action::EnterBuildingSubmenu => current_player.handle_other(action),
        _ => {}
    }
}

fn is_retraining_order_id(order_id: FourCC) -> bool {
    let encoded = [order_id[3], order_id[2], order_id[1], order_id[0]];
    encoded == *b"tert" || encoded == *b"tret"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_reforged_replay_high_level() {
        let bytes = include_bytes!("../fixtures/replays/132/reforged1.w3g");
        let mut parser = W3GReplay::new();
        let output = parser.parse_bytes(bytes).unwrap();

        assert_eq!(output.version, "1.32");
        assert_eq!(output.build_number, 6091);
        assert_eq!(output.players.len(), 2);
        assert_eq!(output.winning_team_id, 1);
        assert_eq!(
            output
                .players
                .iter()
                .find(|player| i16::from(player.teamid) == output.winning_team_id)
                .unwrap()
                .name,
            "anXieTy#2932"
        );
    }

    #[test]
    fn parses_replay_summary_and_low_level_details_once() {
        let bytes = include_bytes!("../fixtures/replays/132/reforged1.w3g");
        let mut parser = W3GReplay::new();
        let parsed = parser.parse_bytes_detailed(bytes).unwrap();

        assert_eq!(parsed.summary.version, "1.32");
        assert_eq!(parsed.summary.players.len(), 2);
        assert_eq!(
            crate::convert::game_version(parsed.low_level.subheader.version),
            parsed.summary.version
        );
        assert!(!parsed.low_level.timed_actions().is_empty());
    }

    #[test]
    fn summary_only_parse_matches_detailed_summary() {
        let bytes = include_bytes!("../fixtures/replays/132/reforged1.w3g");
        let mut summary_parser = W3GReplay::new();
        let mut detailed_parser = W3GReplay::new();
        let mut summary = summary_parser.parse_bytes(bytes).unwrap();
        let mut detailed_summary = detailed_parser.parse_bytes_detailed(bytes).unwrap().summary;

        summary.parse_time = 0;
        detailed_summary.parse_time = 0;

        assert_eq!(summary, detailed_summary);
    }

    #[test]
    fn phased_parse_matches_normal_summary() {
        let bytes = include_bytes!("../fixtures/replays/132/reforged1.w3g");
        let mut summary_parser = W3GReplay::new();
        let mut phased_parser = W3GReplay::new();
        let mut summary = summary_parser.parse_bytes(bytes).unwrap();
        let mut phased = phased_parser.parse_bytes_with_phases(bytes).unwrap();

        summary.parse_time = 0;
        phased.output.parse_time = 0;

        assert_eq!(summary, phased.output);
        assert!(phased.phases.total_ms > 0.0);
        assert!(phased.phases.decompress_ms > 0.0);
        assert!(phased.phases.game_data_ms > 0.0);
        assert!(phased.phases.game_data_timeslots > 0);
        assert!(phased.phases.game_data_command_blocks > 0);
        assert!(phased.phases.game_data_actions > 0);
    }

    #[test]
    fn parses_netease_replay_high_level() {
        let bytes = include_bytes!("../fixtures/replays/132/netease_132.nwg");
        let mut parser = W3GReplay::new();
        let output = parser.parse_bytes(bytes).unwrap();

        assert_eq!(output.version, "1.32");
        assert_eq!(output.build_number, 6105);
        assert_eq!(output.players.len(), 2);
        assert_eq!(output.players[0].name, "HurricaneBo");
        assert_eq!(output.players[1].name, "SimplyHunteR");
        assert_eq!(output.winning_team_id, 0);
    }
}
