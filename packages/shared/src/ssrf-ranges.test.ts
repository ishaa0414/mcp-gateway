import { describe, expect, it } from 'vitest'
import { isBlockedIpv4, isBlockedIpv6 } from './ssrf-fetch.js'

describe('additional blocked IPv4 ranges', () => {
  it.each([
    ['224.0.0.0'], // multicast start
    ['224.0.0.251'], // mDNS
    ['239.255.255.255'], // multicast end
    ['240.0.0.0'], // reserved start
    ['250.1.2.3'],
    ['255.255.255.255'], // limited broadcast
    ['198.18.0.0'], // benchmarking start
    ['198.19.255.255'], // benchmarking end
  ])('blocks %s', (ip) => {
    expect(isBlockedIpv4(ip)).toBe(true)
  })

  it.each([
    ['223.255.255.254'], // last unicast before multicast
    ['198.17.255.255'], // just below 198.18.0.0/15
    ['198.20.0.0'], // just above it
    ['8.8.8.8'],
  ])('still allows %s', (ip) => {
    expect(isBlockedIpv4(ip)).toBe(false)
  })
})

describe('additional blocked IPv6 ranges', () => {
  it.each([
    ['64:ff9b::7f00:1'], // NAT64 wrapping 127.0.0.1
    ['64:ff9b::a9fe:a9fe'], // NAT64 wrapping the metadata address
    ['64:ff9b::1.2.3.4'], // dotted form, even for a public IPv4
    ['64:ff9b::'],
    ['64:ff9b:0:0:0:0:0:1'], // expanded spelling
  ])('blocks NAT64 address %s', (ip) => {
    expect(isBlockedIpv6(ip)).toBe(true)
  })

  it.each([
    ['0:0:0:0:0:ffff:7f00:1'], // mapped 127.0.0.1 in full form
    ['0:0:0:0:0:ffff:10.0.0.1'],
    ['0:0:0:0:0:0:0:1'],
    ['::127.0.0.1'], // deprecated IPv4-compatible
    ['::ffff:169.254.169.254'],
  ])('blocks other spellings of private addresses: %s', (ip) => {
    expect(isBlockedIpv6(ip)).toBe(true)
  })

  it.each([['64:ff9a::1'], ['64:ff9b:1::1'], ['::ffff:8.8.8.8'], ['2606:4700:4700::1111']])(
    'does not over-block %s',
    (ip) => {
      expect(isBlockedIpv6(ip)).toBe(false)
    }
  )

  it.each([['not-an-ip'], ['1:2:3'], ['1::2::3'], ['12345::1'], ['::ffff:300.1.1.1']])(
    'fails closed on malformed %s',
    (ip) => {
      expect(isBlockedIpv6(ip)).toBe(true)
    }
  )
})
