/* IPv6 *inside* the tunnel, server mode with direct AmneziaWG clients.
 *
 * A phone/laptop client asks for ::/0 and gets a /128 out of a ULA /64 that is
 * derived from the IPv4 tunnel subnet — so a client added later from the share
 * link (which carries only the v4 subnet) lands on the same /64, and a hub
 * installed before this feature existed keeps generating its old config.
 *
 * Dev-only:
 *   npm install jsdom && node tests/conf3.0-srv-tunnel6.test.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'conf3.0.html'), 'utf8');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
    if (cond) { passes++; console.log('  PASS  ' + name); }
    else { fails++; console.log('  FAIL  ' + name + (extra ? ': ' + extra : '')); }
}
function eq(name, a, b) { ok(name, a === b, JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }

const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://example.invalid/' });
const w = dom.window;

const need = ['buildServerCommands', 'buildAwgConf', 'getInnerTunnel6',
              'parseSlash24', 'generateAWGParams'];
const missing = need.filter(n => typeof w[n] !== 'function');
if (missing.length) {
    console.log('  FAIL  functions not reachable: ' + missing.join(', '));
    process.exit(1);
}

console.log('=== conf3.0 server-mode inner IPv6 tests ===');

const TUN = '10.197.67.0/24';
const PREFIX = 'awg-server-1';

function profile() {
    const p = { jc: 3, jmin: 73, jmax: 660, s1: 46, s2: 43, s3: 26, s4: 12,
                h1: '1648096627-1648096648', h2: '2032112331-2032112354',
                h3: '2474039302-2474039316', h4: '3650246481-3650246497',
                level: 'v3', hpKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
                cps: null, chain: [] };
    p.port = 8443;
    p.wgListenPort = 41602;
    return p;
}

/* ---- the derivation itself ---- */
const tun = w.parseSlash24(TUN);
const n6 = w.getInnerTunnel6(tun);
eq('ULA from 10.197.67.0/24', n6.net, 'fdc5:43::/64');
eq('hub address is ::1', n6.server, 'fdc5:43::1');
eq('client 1 is ::2', n6.host(1), 'fdc5:43::2');
eq('client 5 is ::6', n6.host(5), 'fdc5:43::6');
ok('different tunnel, different /64',
   w.getInnerTunnel6(w.parseSlash24('10.20.3.0/24')).net !== n6.net);
ok('derivation is stable',
   w.getInnerTunnel6(w.parseSlash24(TUN)).net === n6.net);

/* ---- direct client (netMode awg): IPv6 is part of the tunnel ---- */
const awg = w.buildServerCommands('vpn.example.com', profile(), TUN, 'disk1', 'disk1',
                                  PREFIX, '', '', 'awg', 1, '1.1.1.1');

ok('hub gets the tunnel /64 on the WG interface',
   awg.server.indexOf('/ipv6/address/add address=fdc5:43::1/64 interface=wg-' + PREFIX) >= 0);
ok('peer is allowed the client /128',
   awg.server.indexOf('allowed-address=10.197.67.2/32,fdc5:43::2/128') >= 0);
ok('NAT66 for the tunnel subnet',
   awg.server.indexOf('/ipv6/firewall/nat/add chain=srcnat action=masquerade src-address=fdc5:43::/64 out-interface-list=WAN comment=' + PREFIX + '-ft-nat6') >= 0);
ok('forward accept into the world', awg.server.indexOf(PREFIX + '-ft-fwd6') >= 0);
ok('return leg accepted explicitly', awg.server.indexOf(PREFIX + '-ft-fwd6r') >= 0);
ok('client conf carries the v6 address',
   awg.awgConf.indexOf('Address = 10.197.67.2/32, fdc5:43::2/128') >= 0, awg.awgConf);
ok('client conf routes ::/0 into the tunnel',
   awg.awgConf.indexOf('AllowedIPs = 0.0.0.0/0, ::/0') >= 0, awg.awgConf);
ok('v4 rules are untouched',
   awg.server.indexOf('hasz') < 0 && awg.server.indexOf(prefixRule(PREFIX, '-ft-fwd')) >= 0,
   awg.server.slice(0, 120));

function prefixRule(p, suffix) { return '/ip/firewall/filter/add chain=forward action=accept in-interface=wg-' + p + ' ' + 'comment=' + p + suffix; }

/* ---- uninstall has to undo all of it, or a reinstall duplicates rules ---- */
ok('uninstall removes the NAT66 rule', awg.server.indexOf('comment=' + PREFIX + '-ft-nat6] } on-error={}') >= 0);
ok('uninstall removes both v6 forward rules',
   awg.server.indexOf('comment=' + PREFIX + '-ft-fwd6] } on-error={}') >= 0 &&
   awg.server.indexOf('comment=' + PREFIX + '-ft-fwd6r] } on-error={}') >= 0);
ok('uninstall removes the WG /64', awg.server.indexOf('/ipv6/address/remove [find where interface="wg-' + PREFIX + '"]') >= 0);

/* ---- router-to-router modes stay IPv4 inside: they route the LAN, not a phone ---- */
['l3', 'none'].forEach(function (netMode) {
    const r = w.buildServerCommands('vpn.example.com', profile(), TUN, 'disk1', 'disk1',
                                    PREFIX, '192.168.1.0/24', '192.168.2.0/24', netMode, 1, '1.1.1.1');
    ok(netMode + ': no inner /64', r.server.indexOf('fdc5:43') < 0);
    ok(netMode + ': no NAT66', r.server.indexOf('/ipv6/firewall/nat/add') < 0);
    ok(netMode + ': allowed-address has no /128', r.server.indexOf('/128') < 0);
    ok(netMode + ': --net ' + netMode + ' .conf has no ::/0', r.awgConf.indexOf('::/0') < 0);
});

/* ---- higher client numbers follow the same /64 ---- */
const c5 = w.buildServerCommands('vpn.example.com', profile(), TUN, 'disk1', 'disk1',
                                 PREFIX, '', '', 'awg', 5, '1.1.1.1');
ok('client 5 gets ::6', c5.awgConf.indexOf('fdc5:43::6/128') >= 0, c5.awgConf);
ok('client 5 v4 is unchanged', c5.awgConf.indexOf('Address = 10.197.67.6/32') >= 0, c5.awgConf);

console.log('\n' + passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
