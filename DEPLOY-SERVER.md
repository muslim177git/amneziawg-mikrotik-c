# Running this fork as an AmneziaWG server on MikroTik — recommended settings

Everything below was verified on a real router: **RB5009UG+S+, arm64, RouterOS
7.25.1**, dual-stack WAN (DHCPv4 + a 6in4 tunnel for IPv6), awg-proxy v1.4.6 image
from upstream. Addresses and keys in this file are placeholders.

The generator produces the whole configuration; this page is about the settings
**around** it — the ones that make it work, and the ones that quietly break it.

---

## 1. Is the router eligible

| Requirement | Why it fails otherwise |
|---|---|
| `arm64`, `arm` or `x86_64`; **no** `mipsbe` / `smips` / `tile` | RouterOS ships no container package for those |
| RouterOS **7.4+**, container package installed. **7.21+** for a plain OCI image, **7.22+** for `remote-image=ghcr.io/…` (one-command updates) | older builds reject the image format |
| `device-mode` allows containers | containers are off by default and enabling needs **physical access** — a button press or power cycle within 5 minutes; a plain reboot cancels it |
| ~16 MB free RAM, ~1 MB free disk besides the image | 1.2 MB RSS in the reference deployment, 194 KB root-dir |
| **ext4** storage (internal flash `disk1`, or ext4 USB) | a FAT32 stick as `root-dir` fails at layer extraction. Personal FAT32 drives are not container storage |
| NTP enabled and the clock right | WireGuard TAI64N timestamps make a stale clock drop every handshake silently |

```routeros
/system/resource/print
/system/package/print
/system/device-mode/print
/system/clock/print
/disk/print detail
/system/ntp/client/print
```

## 2. Before you change anything

```routeros
/export compact file=pre-awg                                             ;# text, diffable
/system/backup/save name=pre-awg dont-encrypt=yes                         ;# binary, restorable
```

Run the generated `awg-server-N-uninstall` script before re-importing an install
script. Importing an install over an existing install **duplicates** every object.

## 3. The `WAN` interface list must exist — and must contain the IPv6 uplink

The generated firewall and NAT rules match `in-interface-list=WAN`, and the script
aborts up front if the list is missing. Create it once:

```routeros
/interface/list/add name=WAN
/interface/list/member/add list=WAN interface=sfp-sfpplus1
```

**If you use IPv6, add the interface the IPv6 traffic actually arrives on** —
`pppoe-out1`, `sit1`, `wg-tunnel`, whatever it is. On a router with a 6in4 tunnel
the IPv6 rules silently match nothing until `sit1` is a member, and the symptom is
"the IPv6 dst-nat rule exists but no one can connect over IPv6".

## 4. Generate the script

```bash
git clone https://github.com/muslim177git/amneziawg-mikrotik-c && cd amneziawg-mikrotik-c
npm install jsdom
node tools/awg-gen.js --mode server --net awg \
    --endpoint vpn.example.com --port 8443 \
    --storage-server disk1 --ipv6 > server.rsc
```

- `--net awg` — phone/laptop clients via the AmneziaVPN app, full tunnel, and (in
  this fork) IPv6 inside the tunnel. `l3` / `none` are for router-to-router.
- `--port` must be **1024–65535** (the configurator refuses well-known ports). Pick
  a fixed port; a random band of 1000 ports is generated alongside it and clients
  rotate over it.
- `--endpoint` — a name is better than an IP on a dynamic WAN. With MikroTik cloud
  DDNS the name carries both an `A` and an `AAAA`, so IPv4-only and IPv6-capable
  clients both work.
- `--storage-server disk1` — internal flash. `usb1` only if that stick is ext4.
- `--ipv6` — dual-stack listener (`AWG_LISTEN=[::]:8443`, one socket, v4-mapped).

## 5. MTU is the setting that breaks tunnels silently

The tunnel MTU belongs to the **outer path**, not to the address family inside:

```
tunnel MTU  ≤  path MTU − IP header − 8 (UDP) − 32 (WireGuard) − S4 (padding)
```

| WAN type | path MTU | IPv4 client | IPv6 client |
|---|---|---|---|
| plain ethernet / DHCP | 1500 | 1420 (fine) | 1408 |
| PPPoE | 1492 | 1420 | 1400 |
| 6in4 / `sit1` | 1480 | 1427 | **1387 → use 1380** |

Set it by hand after install — server mode emits no `mtu=` for a hostname endpoint:

```routeros
/interface/wireguard/set [find name=wg-awg-server-1] mtu=1380
```

Symptoms of getting it wrong: handshake succeeds, ping works, but pages hang or
load every other time and QUIC video stalls. `change-mss` does not fix this.

## 6. Container settings that matter

The generator sets these; the values from the reference deployment are here so you
can sanity-check yours with `/container/print detail`:

| Setting | Value | Why |
|---|---|---|
| `remote-image` | `ghcr.io/timbrs/awg-proxy:latest` | upstream image, unmodified by this fork |
| `root-dir` | `/disk1/awg-server-1` (internal flash) | survives reboot; 194 KB |
| `privileged` | `yes` | lifts the socket receive-buffer cap; without it upload is roughly half of download |
| `shm-size` | `4096KiB` | required by the OCI image on RouterOS |
| `start-on-boot` | `yes` | a reboot must not need a human |
| `restart-policy` | `always`, interval `30s`, max `10` | a crash (native panic, OOM) self-heals |
| `logging` | `no` | the container's stdout is chatty; turn on only while debugging |
| `dns` | **`""` (empty)** — set explicitly | RouterOS 7.24+ refuses to start a container when no plain DNS is configured; a hub resolving nothing needs none |
| `shm-size`, `memory-max` | leave unlimited except `shm-size` | 1.2 MB used; no reason to cap |

`AWG_LISTEN=[::]:8443` gives one socket for both families; `AWG_LISTEN=:8443` is
IPv4-only. Don't change either by hand — regenerate.

## 7. What the script inserts into your firewall, and where

Rules are inserted at the **top of the chain**, above your existing policy, and
only in front of the first **static** rule — a dynamic rule at index 0 (for
example `back-to-home-vpn`) makes `place-before=0` fail outright with
`item referred by 'place-before' does not exist (11)`, which is one of the bugs
this fork fixes.

| Rule | Chain | Meaning |
|---|---|---|
| `awg-in` / `awg-in6` | forward | accept AWG UDP to the container's veth |
| `wg-in` | input | container → router's WireGuard listener |
| `wg-mgmt` | input | **accept everything from the tunnel interface** |
| `ft-fwd` / `ft-fwd6` / `ft-fwd6r` | forward | tunnel → LAN/WAN and the return leg |
| `dstnat` / `dstnat6` | nat | public UDP → container |

`wg-mgmt` deserves a decision: as generated, a connected client can reach the
router itself on every port. If clients are only supposed to use the internet
through the tunnel, replace it with something narrower, e.g. keep DNS only:

```routeros
/ip/firewall/filter/set [find where comment=awg-server-1-wg-mgmt] disabled=yes
/ip/firewall/filter/add chain=input action=accept protocol=udp dst-port=53 \
    in-interface=wg-awg-server-1 comment=awg-server-1-wg-dns place-before=1
```

FastTrack is fine: the inserted rules sit above it. Per-service routing tricks
(`dns-fwd`, address lists) do **not** work when the client reaches the router over
the tunnel — the router's own DNS is not in that path. Use a policy route or the
full tunnel instead.

## 8. Install and verify

```bash
scp server.rsc admin@router:server.rsc
```

```routeros
/import file-name=server.rsc verbose=yes
/container/print                                    ;# R = running
/log/print where topics~"container"                 ;# "started /awg-proxy"
/interface/wireguard/print                          ;# wg-awg-server-1, mtu 1380
/interface/wireguard/peers/print                    ;# last-handshake within 2 min of a client connecting
/ipv6/address/print where interface~"wg-awg"        ;# the tunnel /64 (this fork)
/ipv6/firewall/nat/print where comment~"-ft-nat6"   ;# NAT66 for it
```

Handshake counters are the only real proof of the data path; "container running"
only proves the container is running.

## 9. Clients

One client per device, always through the generator — never hand-written:

```bash
URL=$(ssh admin@router ':put [/container/envs/get [find where key="AWG_CONFIG_URL"] value]')
node tools/awg-gen.js --mode server --share-url "$URL" --client 2 --dns 1.1.1.1
```

The output has a `[client]` part (the `.conf` to import) and a `[server-update]`
part (peer + `AWG_CLIENT_PUBS` + container restart). Import the update on the
router, then **store the link for client 3** — the hub reads `AWG_CLIENT_PUBS`
only at container start, so the update script restarts it; clients reconnect in
a few seconds.

## 10. Troubleshooting the failures actually seen in the wild

| Symptom | Cause | Fix |
|---|---|---|
| `item referred by 'place-before' does not exist (11)` mid-import | dynamic rule at index 0 | this fork fixes it; otherwise re-import after `awg-server-1-uninstall` |
| rule exists, but nothing reaches the container over IPv6 | the IPv6 uplink interface is not in `WAN` | add it (`§3`) |
| `start failed: no default dns servers` | 7.24+ with no plain DNS configured | `/container/set [find comment=awg-server-1] dns=""` |
| `no space to extract layer` / layer errors | FAT32 or tiny storage | ext4 USB or `disk1` |
| handshake ok, everything else hangs | MTU too large for the path | `§5` |
| container down after `ghcr.io` pull | registry hiccup | the update script rebuilds from the registry; otherwise re-import |
| connect works, no internet | `ft-nat`/`ft-fwd` missing, or the tunnel's `/128` missing after adding a client from a stale link | regenerate the link (fork fix `39779a0`) |

## 11. Reference deployment

```
Router     RB5009UG+S+, arm64, RouterOS 7.25.1
WAN        DHCPv4 + 6in4 tunnel for IPv6 (path MTU 1480)
Storage    internal flash, root-dir /disk1/awg-server-1
Container  ghcr.io/timbrs/awg-proxy:latest, privileged, 1.2 MB RSS
Tunnel     v4 10.x.y.0/24, v6 (ULA derived from it), MTU 1380
Public     UDP 8443 + a 1000-port rotation band, dual-stack listener
Clients    AmneziaVPN app, full tunnel, AllowedIPs 0.0.0.0/0, ::/0
```
