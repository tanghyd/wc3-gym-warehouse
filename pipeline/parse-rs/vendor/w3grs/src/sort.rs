//! Player sort helper port.

use std::cmp::Ordering;

pub trait SortablePlayer {
    fn team_id(&self) -> u8;
    fn id(&self) -> u8;
}

pub fn sort_players<T: SortablePlayer>(player1: &T, player2: &T) -> Ordering {
    player1
        .team_id()
        .cmp(&player2.team_id())
        .then_with(|| player1.id().cmp(&player2.id()))
}

pub fn sort_player_keys((team1, id1): (u8, u8), (team2, id2): (u8, u8)) -> Ordering {
    team1.cmp(&team2).then_with(|| id1.cmp(&id2))
}
