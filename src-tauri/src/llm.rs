use if_addrs::{get_if_addrs, IfAddr};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

const OLLAMA_PORT: u16 = 11434;
const LM_STUDIO_PORT: u16 = 1234;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmEndpointCandidate {
    pub provider_id: String,
    pub endpoint: String,
    pub scope: String,
    pub host: String,
    pub port: u16,
    pub interface_id: String,
    pub interface_name: String,
    pub network_cidr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmNetworkInterface {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub cidr: String,
    pub is_private: bool,
    pub is_loopback: bool,
    pub is_link_local: bool,
    pub is_default_candidate: bool,
}

#[derive(Debug, Clone)]
struct NetworkScanTarget {
    id: String,
    name: String,
    ip: Ipv4Addr,
    netmask: Ipv4Addr,
    cidr: String,
    is_private: bool,
    is_loopback: bool,
    is_link_local: bool,
}

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
}

fn is_link_local_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 169 && octets[1] == 254
}

fn interface_id(name: &str, ip: Ipv4Addr, cidr: &str) -> String {
    format!("{name}|{ip}|{cidr}")
}

fn netmask_prefix(mask: Ipv4Addr) -> u8 {
    ipv4_to_u32(mask).count_ones() as u8
}

fn network_cidr(ip: Ipv4Addr, netmask: Ipv4Addr) -> String {
    let network = ipv4_to_u32(ip) & ipv4_to_u32(netmask);
    format!("{}/{}", u32_to_ipv4(network), netmask_prefix(netmask))
}

fn scan_score(target: &NetworkScanTarget) -> i32 {
    let mut score = 0;
    if target.is_private {
        score += 200;
    }
    if !target.is_loopback {
        score += 40;
    } else {
        score -= 200;
    }
    if !target.is_link_local {
        score += 30;
    } else {
        score -= 250;
    }
    let prefix = netmask_prefix(target.netmask);
    if prefix == 24 {
        score += 10;
    }
    score
}

fn collect_ipv4_interfaces(include_non_private: bool, include_loopback: bool) -> Vec<NetworkScanTarget> {
    let Ok(ifaces) = get_if_addrs() else {
        return Vec::new();
    };

    let mut targets = Vec::new();
    for iface in ifaces {
        let IfAddr::V4(v4) = iface.addr else {
            continue;
        };
        let ip = v4.ip;
        let private = is_private_ipv4(ip);
        let loopback = ip.is_loopback();
        let link_local = is_link_local_ipv4(ip);

        if !include_loopback && loopback {
            continue;
        }
        if !include_non_private && !private {
            continue;
        }

        let cidr = network_cidr(ip, v4.netmask);
        targets.push(NetworkScanTarget {
            id: interface_id(iface.name.as_str(), ip, cidr.as_str()),
            name: iface.name,
            ip,
            netmask: v4.netmask,
            cidr,
            is_private: private,
            is_loopback: loopback,
            is_link_local: link_local,
        });
    }

    targets.sort_by(|left, right| {
        scan_score(right)
            .cmp(&scan_score(left))
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.ip.cmp(&right.ip))
    });
    targets
}

pub fn list_network_interfaces(include_non_private: bool, include_loopback: bool) -> Vec<LlmNetworkInterface> {
    let targets = collect_ipv4_interfaces(include_non_private, include_loopback);
    let default_id = targets
        .iter()
        .find(|target| target.is_private && !target.is_loopback && !target.is_link_local)
        .map(|target| target.id.clone())
        .or_else(|| {
            targets
                .iter()
                .find(|target| !target.is_loopback && !target.is_link_local)
                .map(|target| target.id.clone())
        });

    targets
        .into_iter()
        .map(|target| LlmNetworkInterface {
            id: target.id.clone(),
            name: target.name,
            ip: target.ip.to_string(),
            cidr: target.cidr,
            is_private: target.is_private,
            is_loopback: target.is_loopback,
            is_link_local: target.is_link_local,
            is_default_candidate: default_id.as_ref().is_some_and(|id| id == &target.id),
        })
        .collect()
}

fn detect_port(host: IpAddr, port: u16, timeout: Duration) -> bool {
    let socket = SocketAddr::new(host, port);
    TcpStream::connect_timeout(&socket, timeout).is_ok()
}

fn detect_provider_on_host(
    host: IpAddr,
    scope: &str,
    timeout: Duration,
    target: Option<&NetworkScanTarget>,
) -> Vec<LlmEndpointCandidate> {
    let interface_id = target
        .map(|value| value.id.clone())
        .unwrap_or_default();
    let interface_name = target
        .map(|value| value.name.clone())
        .unwrap_or_default();
    let network_cidr = target
        .map(|value| value.cidr.clone())
        .unwrap_or_default();

    let mut hits = Vec::new();
    if detect_port(host, OLLAMA_PORT, timeout) {
        hits.push(LlmEndpointCandidate {
            provider_id: "ollama".to_string(),
            endpoint: format!("http://{host}:{OLLAMA_PORT}"),
            scope: scope.to_string(),
            host: host.to_string(),
            port: OLLAMA_PORT,
            interface_id: interface_id.clone(),
            interface_name: interface_name.clone(),
            network_cidr: network_cidr.clone(),
        });
    }
    if detect_port(host, LM_STUDIO_PORT, timeout) {
        hits.push(LlmEndpointCandidate {
            provider_id: "lmstudio".to_string(),
            endpoint: format!("http://{host}:{LM_STUDIO_PORT}"),
            scope: scope.to_string(),
            host: host.to_string(),
            port: LM_STUDIO_PORT,
            interface_id,
            interface_name,
            network_cidr,
        });
    }
    hits
}

pub fn detect_local_providers() -> Vec<LlmEndpointCandidate> {
    detect_provider_on_host(
        IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
        "localhost",
        Duration::from_millis(180),
        None,
    )
}

fn ipv4_to_u32(value: Ipv4Addr) -> u32 {
    u32::from_be_bytes(value.octets())
}

fn u32_to_ipv4(value: u32) -> Ipv4Addr {
    Ipv4Addr::from(value.to_be_bytes())
}

fn hosts_for_interface(ip: Ipv4Addr, netmask: Ipv4Addr, cap: usize) -> Vec<Ipv4Addr> {
    if cap == 0 {
        return Vec::new();
    }

    let ip_u32 = ipv4_to_u32(ip);
    let mask_u32 = ipv4_to_u32(netmask);
    let network = ip_u32 & mask_u32;
    let broadcast = network | !mask_u32;

    let mut hosts = Vec::new();
    if broadcast <= network + 1 {
        return hosts;
    }

    let total_hosts = (broadcast - network - 1) as usize;
    if total_hosts <= cap {
        for host in (network + 1)..broadcast {
            if host == ip_u32 {
                continue;
            }
            hosts.push(u32_to_ipv4(host));
        }
        return hosts;
    }

    // Cap large networks to the interface's /24 neighborhood for bounded scan time.
    let octets = ip.octets();
    let base = Ipv4Addr::new(octets[0], octets[1], octets[2], 0);
    let base_u32 = ipv4_to_u32(base);
    for host in (base_u32 + 1)..(base_u32 + 255) {
        if host == ip_u32 {
            continue;
        }
        hosts.push(u32_to_ipv4(host));
        if hosts.len() >= cap {
            break;
        }
    }

    hosts
}

fn resolve_scan_target(interface_id: Option<&str>) -> Option<NetworkScanTarget> {
    if let Some(id) = interface_id.map(str::trim).filter(|value| !value.is_empty()) {
        let all = collect_ipv4_interfaces(true, true);
        if let Some(target) = all.into_iter().find(|target| target.id == id) {
            return Some(target);
        }
    }

    collect_ipv4_interfaces(false, false).into_iter().next()
}

pub fn scan_lan_providers(interface_id: Option<&str>, max_hosts: usize) -> Vec<LlmEndpointCandidate> {
    let Some(target) = resolve_scan_target(interface_id) else {
        return Vec::new();
    };
    let hosts = hosts_for_interface(target.ip, target.netmask, max_hosts.clamp(16, 2048));
    if hosts.is_empty() {
        return Vec::new();
    }

    let timeout = Duration::from_millis(120);
    let mut hits = hosts
        .par_iter()
        .flat_map_iter(|host| detect_provider_on_host(IpAddr::V4(*host), "lan", timeout, Some(&target)))
        .collect::<Vec<_>>();

    let mut dedupe = HashSet::new();
    hits.retain(|hit| dedupe.insert(format!("{}|{}", hit.provider_id, hit.endpoint)));
    hits.sort_by(|left, right| left.endpoint.cmp(&right.endpoint));
    hits
}

#[cfg(test)]
mod tests {
    use crate::LlmConnectionTestResult;

    #[test]
    fn test_preferred_model_from_detected_models() {
        let result = LlmConnectionTestResult {
            ok: true,
            provider: "ollama".to_string(),
            base_url: "http://localhost:11434".to_string(),
            status_code: Some(200),
            message: "Connection successful".to_string(),
            detected_models: vec!["llama3".to_string(), "gpt-4o".to_string(), "mistral".to_string()],
            preferred_model: None,
        };

        let preferred_model = result.detected_models.first().cloned();
        assert_eq!(preferred_model, Some("llama3".to_string()));
    }

    #[test]
    fn test_preferred_model_empty_detected_models() {
        let result = LlmConnectionTestResult {
            ok: true,
            provider: "ollama".to_string(),
            base_url: "http://localhost:11434".to_string(),
            status_code: Some(200),
            message: "Connection successful".to_string(),
            detected_models: vec![],
            preferred_model: None,
        };

        let preferred_model = result.detected_models.first().cloned();
        assert_eq!(preferred_model, None);
    }
}
