//! Hero ability retraining helpers port.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

const RETRAINING_DETECTION_TIME_RANGE: u32 = 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum AbilityOrderEntry {
    Ability { time: u32, value: String },
    Retraining { time: u32 },
}

impl AbilityOrderEntry {
    pub fn time(&self) -> u32 {
        match self {
            AbilityOrderEntry::Ability { time, .. } | AbilityOrderEntry::Retraining { time } => {
                *time
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetrainingHistory {
    pub time: u32,
    pub abilities: HashMap<String, u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InferredHeroAbilityLevels {
    pub final_hero_abilities: HashMap<String, u32>,
    pub retraining_history: Vec<RetrainingHistory>,
}

pub fn get_retraining_index(
    ability_order: &[AbilityOrderEntry],
    time_of_tome_of_retraining_purchase: u32,
) -> Option<usize> {
    if ability_order.len() < 3 {
        return None;
    }

    let mut candidate = &ability_order[0];
    let mut candidate_index = 0;
    let mut abilities_learned_in_detection_time_range = 0;

    for (index, ability) in ability_order.iter().enumerate().skip(1) {
        if ability.time() - candidate.time() < RETRAINING_DETECTION_TIME_RANGE {
            abilities_learned_in_detection_time_range += 1;
        } else {
            abilities_learned_in_detection_time_range = 0;
            candidate = ability;
            candidate_index = index;
        }

        if abilities_learned_in_detection_time_range == 2
            && candidate
                .time()
                .saturating_sub(time_of_tome_of_retraining_purchase)
                <= RETRAINING_DETECTION_TIME_RANGE
        {
            return Some(candidate_index);
        }
    }

    None
}

pub fn infer_hero_ability_levels_from_ability_order(
    ability_order: &[AbilityOrderEntry],
) -> InferredHeroAbilityLevels {
    let mut abilities = HashMap::new();
    let mut retrainings = Vec::new();

    for ability in ability_order {
        match ability {
            AbilityOrderEntry::Ability { value, .. } => {
                if is_ultimate(value) && abilities.get(value) == Some(&1) {
                    continue;
                }
                let level = abilities.entry(value.clone()).or_insert(0);
                if *level < 3 {
                    *level += 1;
                }
            }
            AbilityOrderEntry::Retraining { time } => {
                retrainings.push(RetrainingHistory {
                    time: *time,
                    abilities,
                });
                abilities = HashMap::new();
            }
        }
    }

    InferredHeroAbilityLevels {
        final_hero_abilities: abilities,
        retraining_history: retrainings,
    }
}

fn is_ultimate(ability: &str) -> bool {
    matches!(
        ability,
        "AEtq"
            | "AEme"
            | "AEsf"
            | "AEsv"
            | "AOww"
            | "AOeq"
            | "AOre"
            | "AOvd"
            | "AUan"
            | "AUin"
            | "AUdd"
            | "AUls"
            | "ANef"
            | "ANch"
            | "ANto"
            | "ANdo"
            | "ANst"
            | "ANrg"
            | "ANg1"
            | "ANg2"
            | "ANg3"
            | "ANvc"
            | "ANtm"
            | "AHmt"
            | "AHav"
            | "AHre"
            | "AHpx"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ability(time: u32, value: &str) -> AbilityOrderEntry {
        AbilityOrderEntry::Ability {
            time,
            value: value.to_string(),
        }
    }

    fn retraining(time: u32) -> AbilityOrderEntry {
        AbilityOrderEntry::Retraining { time }
    }

    #[test]
    fn caps_normal_abilities_at_three_and_ultimates_at_one() {
        let order = vec![
            ability(1, "AHbz"),
            ability(2, "AHbz"),
            ability(3, "AHbz"),
            ability(4, "AHbz"),
            ability(5, "AHmt"),
            ability(6, "AHmt"),
        ];

        let inferred = infer_hero_ability_levels_from_ability_order(&order);
        assert_eq!(inferred.final_hero_abilities["AHbz"], 3);
        assert_eq!(inferred.final_hero_abilities["AHmt"], 1);
    }

    #[test]
    fn matches_upstream_kotg_ultimate_inference_case() {
        let order = vec![
            ability(126467, "AEfn"),
            ability(178541, "AEer"),
            ability(534905, "AEfn"),
            ability(1016408, "AEer"),
            ability(1907059, "AEer"),
            ability(2091683, "AEtq"),
            ability(2093068, "AEtq"),
            ability(2093226, "AEtq"),
            ability(2093357, "AEtq"),
            ability(2093505, "AEtq"),
            ability(2093617, "AEtq"),
            ability(2093738, "AEtq"),
            ability(2093847, "AEtq"),
            ability(2094002, "AEtq"),
            ability(2094137, "AEtq"),
            ability(2094271, "AEtq"),
            ability(2094393, "AEtq"),
            ability(2094526, "AEtq"),
            ability(2094671, "AEtq"),
        ];

        let inferred = infer_hero_ability_levels_from_ability_order(&order);
        assert_eq!(inferred.final_hero_abilities["AEfn"], 2);
        assert_eq!(inferred.final_hero_abilities["AEer"], 3);
        assert_eq!(inferred.final_hero_abilities["AEtq"], 1);
        assert!(inferred.retraining_history.is_empty());
    }

    #[test]
    fn matches_upstream_retrained_archmage_inference_case() {
        let order = vec![
            ability(125743, "AHwe"),
            ability(167347, "AHab"),
            ability(230430, "AHwe"),
            ability(543939, "AHab"),
            ability(818999, "AHwe"),
            ability(1211048, "AHmt"),
            retraining(1399843),
            ability(1443410, "AHbz"),
            ability(1443563, "AHbz"),
            ability(1443685, "AHbz"),
            ability(1444048, "AHab"),
            ability(1444231, "AHab"),
            ability(1444384, "AHmt"),
        ];

        let inferred = infer_hero_ability_levels_from_ability_order(&order);
        assert_eq!(inferred.final_hero_abilities["AHbz"], 3);
        assert_eq!(inferred.final_hero_abilities["AHab"], 2);
        assert_eq!(inferred.final_hero_abilities["AHmt"], 1);
        assert_eq!(inferred.retraining_history.len(), 1);
        assert_eq!(inferred.retraining_history[0].time, 1399843);
        assert_eq!(inferred.retraining_history[0].abilities["AHab"], 2);
        assert_eq!(inferred.retraining_history[0].abilities["AHmt"], 1);
        assert_eq!(inferred.retraining_history[0].abilities["AHwe"], 3);
    }

    #[test]
    fn matches_upstream_retraining_detection_cases() {
        let positive = vec![
            ability(125743, "AHwe"),
            ability(167347, "AHab"),
            ability(230430, "AHwe"),
            ability(543939, "AHab"),
            ability(818999, "AHwe"),
            ability(1211048, "AHmt"),
            ability(1443410, "AHbz"),
            ability(1443563, "AHbz"),
            ability(1443685, "AHbz"),
            ability(1444048, "AHab"),
            ability(1444231, "AHab"),
            ability(1444384, "AHmt"),
        ];
        assert_eq!(get_retraining_index(&positive, 1399843), Some(6));

        let negative_cases = [
            vec![
                ability(141559, "ANsg"),
                ability(372693, "ANsg"),
                ability(523758, "ANsw"),
                ability(523879, "ANsw"),
                ability(701002, "ANsg"),
                ability(1080754, "ANst"),
                ability(1468279, "ANsw"),
            ],
            vec![
                ability(631947, "ANbf"),
                ability(689454, "ANdh"),
                ability(910900, "ANbf"),
                ability(1069108, "ANdb"),
                ability(1240983, "ANbf"),
            ],
            vec![ability(1236109, "ANsi"), ability(1458928, "ANba")],
            vec![
                ability(603355, "AHtb"),
                ability(700216, "AHbh"),
                ability(812728, "AHtb"),
                ability(978714, "AHbh"),
                ability(1396510, "AHtc"),
            ],
            vec![
                ability(905886, "AHhb"),
                ability(1028782, "AHds"),
                ability(1404045, "AHhb"),
                ability(1510753, "AHad"),
            ],
        ];

        for case in negative_cases {
            assert_eq!(get_retraining_index(&case, 1399843), None);
        }
    }
}
