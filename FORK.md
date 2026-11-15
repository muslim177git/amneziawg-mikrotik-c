# This is a fork — what it is, where it comes from, what changed

## Where it comes from

| | |
|---|---|
| Upstream | **https://github.com/timbrs/amneziawg-mikrotik-c** by [@timbrs](https://github.com/timbrs) |
| Upstream version this fork is based on | **v1.4.6**, commit `50ba1d9` ("1.4.6: отдача быстрее — ядро WireGuard обходится, отдачу шлёт свой поток") |
| License | MIT (upstream `LICENSE`, kept unchanged — Copyright (c) 2026 awg-proxy) |
| What upstream is | The configurator + generator for **awg-proxy**, a ~90 KB RouterOS container that makes a MikroTik router talk AmneziaWG (DPI-resistant WireGuard). It re-dresses the router's own WireGuard packets — junk packets, header ranges, padding, header protection — and holds no keys itself. |

**The container image is not part of this fork and is not modified.** Everything here
generates router configuration; the binary that actually runs is pulled from the
upstream image `ghcr.io/timbrs/awg-proxy:latest` (arm64 in the reference
deployment, ~90 KB, v1.4.6). No C source, no `Dockerfile`, no build script and no
`AWG_*` environment variable was changed. If you want a different image, that is a
change to `src/` and `Dockerfile`, i.e. a different fork.

So: **same container, different router config.** The two commits below change the
commands the generator emits and the `.conf` it hands out.

## What changed (2 commits on top of upstream)

```
39779a0  share link: stop collapsing 'awg' into 'none'
a611e9e  server mode: carry IPv6 inside the tunnel for direct clients
```

```
 docs/conf3.0.html                 |  69 ++++++++++++++++++--
 docs/en/protocol.md               |   2 +-
 docs/en/server-mode.md            |  48 ++++++++++++++
 tests/conf3.0-ipv6.test.js        |   4 +-
 tests/conf3.0-preflight.test.js   |  31 +++++----
 tests/conf3.0-srv-tunnel6.test.js | 134 ++++++++++++++++++++++++++++++++++++++
```

### 1. `a611e9e` — IPv6 inside the tunnel for direct phone/laptop clients

**Problem.** In server mode with `--net awg` (a phone or laptop connecting with the
AmneziaVPN app) the generated `.conf` had `AllowedIPs = 0.0.0.0/0` only. The
client's IPv6 therefore went *around* the tunnel: on a network where IPv6 is
missing, filtered or broken — the very network a full tunnel is supposed to fix —
the tunnel could not carry it, and on a working network the client's IPv6 leaked
past the VPN.

**Change.** The tunnel now carries `::/0` as well, over a ULA `/64` **derived from
the IPv4 tunnel subnet**: `10.197.67.0/24` → `fdc5:43::/64` (new helper
`getInnerTunnel6()`). Derivation instead of a new link field is deliberate — the
share link is a frozen binary format that carries only the IPv4 subnet, and a
client added from that link later has to land on the same `/64`.

On the server this adds:

```routeros
/ipv6/address/add address=fdc5:43::1/64 interface=wg-awg-server-1
/ipv6/firewall/nat/add chain=srcnat action=masquerade src-address=fdc5:43::/64 \
    out-interface-list=WAN comment=awg-server-1-ft-nat6
/ipv6/firewall/filter/add chain=forward action=accept in-interface=wg-awg-server-1 \
    comment=awg-server-1-ft-fwd6
/ipv6/firewall/filter/add chain=forward action=accept out-interface=wg-awg-server-1 \
    connection-state=established,related comment=awg-server-1-ft-fwd6r
```

and every peer gets a second address: `allowed-address=10.197.67.2/32,fdc5:43::2/128`.
The client `.conf` gets `Address = <v4>/32, <ula>::N/128` and
`AllowedIPs = 0.0.0.0/0, ::/0`. The uninstall script removes all of it.

Design decisions, and why:

- **NAT66, not a delegated prefix.** A client cannot be handed an address out of
  the ISP's `/64` (a `/128` on the WAN cannot be split, and a routed prefix is not
  something a script can count on), so tunneled IPv6 leaves through whichever
  global address the router already has. With a static delegated prefix you can
  replace the masquerade with `action=src-nat to-address=<prefix>::N`.
- **The return leg gets its own rule.** Not every IPv6 forward chain on a working
  router has an `established,related` accept to fall back on; a missing one shows
  up as "connects, nothing loads".
- **Only `--net awg`.** `l3` and `none` (router-to-router) stay IPv4 inside: they
  route LANs, not a phone, and silently changing their addressing would be a
  surprise.

### 2. `39779a0` — the share link stored "direct client" as "none"

**Problem.** Found while testing change 1. The link's net-mode byte encoded
`'awg'` as **0 — the same value as `'none'`**, so a client added later from the
stored link was treated as a router-to-router client: no tunnel `/128`, no `::/0`
in the `.conf`, and the page refused a hostname endpoint with *"a DNS server is
required"*, which a direct client does not need. Harmless before the tunnel
carried IPv6; wrong the moment it did.

**Change.** Byte 3 of the link now means `awg` (`0=none, 1=l3, 2=l2, 3=awg`).
Old links still decode as `none` — nothing that ever meant `awg` decodes
differently — so the frozen-link contract holds: no field was reordered or
removed, one spare value was used.

### 3. Also in `a611e9e` — `firewallTopRule()` failed on dynamic rules

`firewallTopRule()` emitted `place-before=0`. When a **dynamic** rule sits at
index 0 — `back-to-home-vpn` installs one for as long as that service is up —
RouterOS answers `item referred by 'place-before' does not exist (11)` and the
import stops **half applied** (veth and addresses created, no WireGuard, no
container). It now anchors on the first *static* rule:
`place-before=[:pick [/…/find where !dynamic] 0]`. This bug is not IPv6-specific;
it hits a plain IPv4 install too, just only on routers where a dynamic rule
happens to be on top.

## Compatibility and migration

- **Old share links** keep working; they just cannot describe an `awg` hub
  (upstream never could). Regenerate the link if you want to add clients to a
  direct-client hub installed before this fork.
- **An existing hub is not upgraded by editing files.** The IPv6 pieces are
  RouterOS objects; they appear only when the install script runs. Regenerating
  the install script and re-importing it over an existing install duplicates
  rules — run the generated `awg-server-N-uninstall` script first, which also
  removes every IPv6 object listed above.
- **MTU belongs to the outer path, not to the address family inside.** A server
  reached over IPv6 on an uplink smaller than 1500 (PPPoE, 6in4/`sit1`) needs the
  WireGuard interface MTU lowered by hand — e.g. on a 1480-byte 6in4 path,
  `1480 − 40 − 8 − 32 − 13 = 1387`, so `mtu=1380`. Server mode still emits no
  `mtu=` for a hostname endpoint, exactly as upstream.

## Tests

```bash
npm install jsdom
node tests/conf3.0-srv-tunnel6.test.js   # 35 assertions, all pass
node tests/awg-gen.test.js               # and the rest of tests/*.test.js
```

`tests/conf3.0-srv-tunnel6.test.js` is new and covers: the `/64` derivation
(stability, uniqueness, client numbering), the server commands, the client
`.conf`, the uninstall, and — through a second jsdom document that parses the
generated link with the page's own decoder — that a client added from the link
lands on the same `/64`.

Two upstream tests, `tests/conf3.0-perfcheck.test.js` and
`tests/conf3.0-warp.test.js`, already failed on pristine `v1.4.6` before any change
here (`perfMode` not reachable; a module load error). They are untouched.

## Deployment status — what is verified and what is not

Verified in the reference deployment (RB5009UG+S+, RouterOS 7.25.1, arm64): the
generated script imports cleanly, the container runs and listens dual-stack
(`AWG_LISTEN=[::]:8443`, one socket for both families), WireGuard carries the
tunnel `/64`, NAT66 and both IPv6 forward rules are present, the peer has its
`/128`, and uninstall removes exactly what install created (checked by running
both twice).

**Not verified: a client handshake.** No phone/laptop connected to the reference
hub during development, and inbound IPv6 to a WAN address can only be proven from
outside that LAN. Treat the IPv6 data path as "generated and installed correctly,
not yet exercised end to end".

## Deployment

The router-side settings that make this work — interface list, MTU table, container
flags, firewall ordering, verification and the failures seen in practice — are in
**[DEPLOY-SERVER.md](DEPLOY-SERVER.md)**.

## Upstream

Both commits are written as upstream patches (`git format-patch`) and are meant to
be offered upstream. If they are merged there, this fork has no reason to exist —
prefer upstream, and keep the fork only for the deployment notes.

## License

MIT, unchanged, with upstream's copyright notice (`LICENSE`). No file in this fork
is relicensed.
