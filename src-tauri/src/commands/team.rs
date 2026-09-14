use crate::db::Database;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamMember {
    pub id: String,
    pub user_id: String,
    pub email: String,
    #[serde(default)]
    pub name: String,
    pub role: String,
    pub status: String,
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub last_seen: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamInfo {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub is_owner: bool,
    pub me: String,
    pub seats_used: u32,
    pub seats_total: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamSnapshot {
    pub team: TeamInfo,
    pub members: Vec<TeamMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Assignment {
    pub id: String,
    pub message_id: String,
    pub account_email: String,
    #[serde(default)]
    pub subject: String,
    pub assigned_by: String,
    pub assigned_to: String,
    pub status: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub updated: String,
}

fn parse<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| format!("Invalid response: {}", e))
}

#[tauri::command]
pub async fn team_heartbeat(db: State<'_, Database>) -> Result<Option<TeamSnapshot>, String> {
    let body = serde_json::json!({ "device_name": super::license::get_device_name() });
    let Some(value) =
        super::license::pb_request(&db, reqwest::Method::POST, "/api/team/heartbeat", Some(body)).await?
    else {
        return Ok(None);
    };
    if value.get("team").map(|t| t.is_null()).unwrap_or(true) {
        return Ok(None);
    }
    parse(value).map(Some)
}

#[tauri::command]
pub async fn team_list_assignments(db: State<'_, Database>) -> Result<Vec<Assignment>, String> {
    let Some(value) =
        super::license::pb_request(&db, reqwest::Method::GET, "/api/team/assignments", None).await?
    else {
        return Ok(vec![]);
    };
    parse(value.get("assignments").cloned().unwrap_or_else(|| serde_json::json!([])))
}

#[tauri::command]
pub async fn team_assign_mail(
    db: State<'_, Database>,
    message_id: String,
    account_email: String,
    assigned_to: String,
    subject: String,
) -> Result<Assignment, String> {
    let body = serde_json::json!({
        "message_id": message_id,
        "account_email": account_email,
        "assigned_to": assigned_to,
        "subject": subject,
    });
    let value = super::license::pb_request(&db, reqwest::Method::POST, "/api/team/assignments", Some(body))
        .await?
        .ok_or("Not logged in")?;
    parse(value)
}

#[tauri::command]
pub async fn team_set_assignment_status(
    db: State<'_, Database>,
    id: String,
    status: String,
) -> Result<Assignment, String> {
    let value = super::license::pb_request(
        &db,
        reqwest::Method::PATCH,
        &format!("/api/team/assignments/{}", id),
        Some(serde_json::json!({ "status": status })),
    )
    .await?
    .ok_or("Not logged in")?;
    parse(value)
}

#[tauri::command]
pub async fn team_unassign(db: State<'_, Database>, id: String) -> Result<(), String> {
    super::license::pb_request(&db, reqwest::Method::DELETE, &format!("/api/team/assignments/{}", id), None)
        .await?
        .ok_or("Not logged in")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_parses_and_defaults_optional_fields() {
        let v = serde_json::json!({
            "team": { "id": "t1", "is_owner": true, "me": "u1", "seats_used": 2, "seats_total": 5 },
            "members": [
                { "id": "owner", "user_id": "u1", "email": "a@b.c", "role": "owner", "status": "active", "online": true, "last_seen": "2026-01-01T00:00:00Z" },
                { "id": "m1", "user_id": "", "email": "new@b.c", "role": "member", "status": "invited" }
            ]
        });
        let s: TeamSnapshot = parse(v).unwrap();
        assert_eq!(s.team.name, "");
        assert!(s.members[0].online);
        assert!(!s.members[1].online);
        assert_eq!(s.members[1].last_seen, "");
    }

    #[test]
    fn assignment_list_parses_without_subject() {
        let v = serde_json::json!([{ "id": "a1", "message_id": "<m>", "account_email": "s@x.de", "assigned_by": "u1", "assigned_to": "u2", "status": "open" }]);
        let list: Vec<Assignment> = parse(v).unwrap();
        assert_eq!(list[0].subject, "");
        assert_eq!(list[0].assigned_to, "u2");
    }
}
