//! Conversion helpers ported from `w3gjs/src/convert.ts`.

pub fn player_color(color: u8) -> &'static str {
    match color {
        0 => "#ff0303",
        1 => "#0042ff",
        2 => "#1ce6b9",
        3 => "#540081",
        4 => "#fffc00",
        5 => "#fe8a0e",
        6 => "#20c000",
        7 => "#e55bb0",
        8 => "#959697",
        9 => "#7ebff1",
        10 => "#106246",
        11 => "#4a2a04",
        12 => "#9b0000",
        13 => "#0000c3",
        14 => "#00eaff",
        15 => "#be00fe",
        16 => "#ebcd87",
        17 => "#f8a48b",
        18 => "#bfff80",
        19 => "#dcb9eb",
        20 => "#282828",
        21 => "#ebf0ff",
        22 => "#00781e",
        23 => "#a46f33",
        _ => "000000",
    }
}

pub fn game_version(version: u32) -> String {
    if version == 10030 {
        "1.30.2+".to_string()
    } else if version > 10030 && version < 10100 {
        let str_version = version.to_string();
        format!("1.{}", &str_version[str_version.len() - 2..])
    } else if version >= 10100 {
        let str_version = version.to_string();
        format!("2.{}", &str_version[str_version.len() - 2..])
    } else {
        format!("1.{version}")
    }
}

pub fn map_filename(map_path: &str) -> String {
    let bytes = map_path.as_bytes();
    let mut segment_start = 0;

    while segment_start < bytes.len() {
        let segment_end = bytes[segment_start..]
            .iter()
            .position(|byte| matches!(byte, b'\\' | b'/'))
            .map_or(bytes.len(), |offset| segment_start + offset);
        let segment = &map_path[segment_start..segment_end];

        if let Some(end) = last_w3gjs_map_extension_end(segment) {
            return segment[..end].to_string();
        }

        segment_start = segment_end.saturating_add(1);
    }

    String::new()
}

fn last_w3gjs_map_extension_end(segment: &str) -> Option<usize> {
    let bytes = segment.as_bytes();
    if bytes.len() < 5 {
        return None;
    }

    (1..=bytes.len() - 4).rev().find_map(|index| {
        matches!(&bytes[index..index + 4], b".w3x" | b".w3m").then_some(index + 4)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_game_versions_like_w3gjs() {
        assert_eq!(game_version(26), "1.26");
        assert_eq!(game_version(10030), "1.30.2+");
        assert_eq!(game_version(10032), "1.32");
        assert_eq!(game_version(10202), "2.02");
    }

    #[test]
    fn extracts_map_filename_with_mixed_separators() {
        assert_eq!(map_filename("Maps\\test\\somemap.w3x"), "somemap.w3x");
        assert_eq!(map_filename("Maps//test//somemap.w3x"), "somemap.w3x");
        assert_eq!(map_filename("Maps//test\\somemap.w3x"), "somemap.w3x");
        assert_eq!(map_filename("Maps\\test//somemap.w3x"), "somemap.w3x");
    }

    #[test]
    fn extracts_map_filename_like_w3gjs_regex() {
        assert_eq!(map_filename("Maps\\test\\somemap.W3X"), "");
        assert_eq!(map_filename("Maps\\test\\somemap.w3x.tmp"), "somemap.w3x");
        assert_eq!(map_filename("Maps\\test\\somemap.w3m"), "somemap.w3m");
        assert_eq!(map_filename("Maps\\test\\.w3x"), "");
    }
}
