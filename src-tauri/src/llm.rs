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
}

fn is_private_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
}

fn detect_port(host: IpAddr, port: u16, timeout: Duration) -> bool {
    let socket = SocketAddr::new(host, port);
    TcpStream::connect_timeout(&socket, timeout).is_ok()
}

fn detect_provider_on_host(host: IpAddr, scope: &str, timeout: Duration) -> Vec<LlmEndpointCandidate> {
    let mut hits = Vec::new();
    if detect_port(host, OLLAMA_PORT, timeout) {
        hits.push(LlmEndpointCandidate {
            provider_id: "ollama".to_string(),
            endpoint: format!("http://{host}:{OLLAMA_PORT}"),
            scope: scope.to_string(),
            host: host.to_string(),
            port: OLLAMA_PORT,
        });
    }
    if detect_port(host, LM_STUDIO_PORT, timeout) {
        hits.push(LlmEndpointCandidate {
            provider_id: "lmstudio".to_string(),
            endpoint: format!("http://{host}:{LM_STUDIO_PORT}"),
            scope: scope.to_string(),
            host: host.to_string(),
            port: LM_STUDIO_PORT,
        });
    }
    hits
}

pub fn detect_local_providers() -> Vec<LlmEndpointCandidate> {
    detect_provider_on_host(
        IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
        "localhost",
        Duration::from_millis(180),
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

    // Cap large subnets to the host's /24 neighborhood for bounded scan time.
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

fn private_interface_hosts(max_hosts: usize) -> Vec<Ipv4Addr> {
    let Ok(ifaces) = get_if_addrs() else {
        return Vec::new();
    };

    let per_iface_cap = max_hosts.clamp(16, 1024);
    let mut dedupe = HashSet::new();
    let mut hosts = Vec::new();

    for iface in ifaces {
        let IfAddr::V4(v4) = iface.addr else {
            continue;
        };
        let ip = v4.ip;
        if ip.is_loopback() || !is_private_ipv4(ip) {
            continue;
        }
        for host in hosts_for_interface(ip, v4.netmask, per_iface_cap) {
            if dedupe.insert(host) {
                hosts.push(host);
                if hosts.len() >= max_hosts {
                    return hosts;
                }
            }
        }
    }

    hosts
}

pub fn scan_lan_providers(max_hosts: usize) -> Vec<LlmEndpointCandidate> {
    let hosts = private_interface_hosts(max_hosts.clamp(16, 1024));
    if hosts.is_empty() {
        return Vec::new();
    }

    let timeout = Duration::from_millis(120);
    let mut hits = hosts
        .par_iter()
        .flat_map_iter(|host| detect_provider_on_host(IpAddr::V4(*host), "lan", timeout))
        .collect::<Vec<_>>();

    hits.sort_by(|left, right| left.endpoint.cmp(&right.endpoint));
    hits
}
