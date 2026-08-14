import { describe, it, expect, vi } from 'vitest'
import {
  AVATAR_SOURCE_DICEBEAR,
  AVATAR_SOURCE_UPLOAD,
  avatarSourceForProvider,
  buildDicebearAvatarDataUrl,
  extractDataUrlPayload,
  shouldStoreDicebearAvatar,
  shouldWriteAvatarSource,
  storeDicebearAvatarAtSignup,
  svgToDataUrl,
  writeOAuthAvatarSource,
} from './avatarStore'

describe('svgToDataUrl', () => {
  it('encodes an svg document as a utf8 data url', () => {
    expect(svgToDataUrl('<svg></svg>')).toBe(
      'data:image/svg+xml;utf8,%3Csvg%3E%3C%2Fsvg%3E',
    )
  })

  it('never contains the raw svg markup (encoded only)', () => {
    const url = svgToDataUrl('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(url.startsWith('data:image/svg+xml;utf8,')).toBe(true)
    expect(url).not.toContain('<svg')
  })
})

describe('extractDataUrlPayload', () => {
  const SVG_DOC =
    "<svg xmlns='http://www.w3.org/2000/svg'><rect width='100' height='100'/></svg>"

  it('round-trips svgToDataUrl output back to the original svg document', () => {
    expect(extractDataUrlPayload(svgToDataUrl(SVG_DOC))).toBe(SVG_DOC)
  })

  it('decodes a raw (unencoded) svg data url payload as-is', () => {
    expect(extractDataUrlPayload(`data:image/svg+xml;utf8,${SVG_DOC}`)).toBe(
      SVG_DOC,
    )
  })

  it('returns null for non-data urls, comma-less urls, and missing media params', () => {
    expect(extractDataUrlPayload('https://cdn.example.com/me.png')).toBeNull()
    expect(extractDataUrlPayload('data:image/svg+xml;utf8')).toBeNull()
    expect(extractDataUrlPayload('data:,<svg></svg>')).toBeNull()
    expect(extractDataUrlPayload('data:image/svg+xml;utf8,')).toBeNull()
  })

  it('returns null when the payload decodes but is not an svg document', () => {
    expect(
      extractDataUrlPayload('data:image/svg+xml;utf8,not%20encoded%20svg'),
    ).toBeNull()
    expect(extractDataUrlPayload('data:text/plain;utf8,hello')).toBeNull()
  })

  it('returns null when the payload fails to decode', () => {
    expect(extractDataUrlPayload('data:image/svg+xml;utf8,%zz')).toBeNull()
  })
})

describe('avatarSourceForProvider', () => {
  it('maps google and github providers to provenance labels', () => {
    expect(avatarSourceForProvider('google')).toBe('google')
    expect(avatarSourceForProvider('github')).toBe('github')
  })

  it('returns null for email, unknown, and missing providers', () => {
    expect(avatarSourceForProvider('email')).toBeNull()
    expect(avatarSourceForProvider('apple')).toBeNull()
    expect(avatarSourceForProvider(null)).toBeNull()
    expect(avatarSourceForProvider(undefined)).toBeNull()
  })
})

describe('shouldStoreDicebearAvatar', () => {
  it('stores when metadata has no avatar_url at all', () => {
    expect(shouldStoreDicebearAvatar(undefined)).toBe(true)
    expect(shouldStoreDicebearAvatar(null)).toBe(true)
    expect(shouldStoreDicebearAvatar({})).toBe(true)
  })

  it('does not store when an avatar_url already exists', () => {
    expect(
      shouldStoreDicebearAvatar({ avatar_url: 'https://cdn.example.com/me.png' }),
    ).toBe(false)
    expect(
      shouldStoreDicebearAvatar({
        avatar_url: 'data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E',
      }),
    ).toBe(false)
  })

  it('stores when avatar_url is empty, whitespace-only, or not a string', () => {
    expect(shouldStoreDicebearAvatar({ avatar_url: '' })).toBe(true)
    expect(shouldStoreDicebearAvatar({ avatar_url: '   ' })).toBe(true)
    expect(shouldStoreDicebearAvatar({ avatar_url: 42 })).toBe(true)
    expect(shouldStoreDicebearAvatar({ avatar_url: null })).toBe(true)
  })
})

describe('shouldWriteAvatarSource', () => {
  it('writes when the user has an avatar_url but no source recorded yet', () => {
    expect(
      shouldWriteAvatarSource(
        { avatar_url: 'https://lh3.googleusercontent.com/me' },
        'google',
      ),
    ).toBe(true)
    expect(
      shouldWriteAvatarSource(
        { avatar_url: 'https://avatars.githubusercontent.com/u/1' },
        'github',
      ),
    ).toBe(true)
  })

  it('does not overwrite an existing avatar_source (idempotent)', () => {
    expect(
      shouldWriteAvatarSource(
        { avatar_url: 'https://x/me.png', avatar_source: 'dicebear' },
        'google',
      ),
    ).toBe(false)
    expect(
      shouldWriteAvatarSource(
        { avatar_url: 'https://x/me.png', avatar_source: 'upload' },
        'google',
      ),
    ).toBe(false)
  })

  it('does not write when there is no avatar_url or the source is unknown', () => {
    expect(shouldWriteAvatarSource({}, 'google')).toBe(false)
    expect(shouldWriteAvatarSource({ name: 'Alice' }, 'google')).toBe(false)
    expect(shouldWriteAvatarSource({ avatar_url: 'https://x/me.png' }, null)).toBe(false)
    expect(shouldWriteAvatarSource({ avatar_url: 'https://x/me.png' }, undefined)).toBe(false)
  })
})

describe('buildDicebearAvatarDataUrl', () => {
  it('produces a deterministic data url for the same email', async () => {
    const first = await buildDicebearAvatarDataUrl('  Alice@Example.COM  ')
    const second = await buildDicebearAvatarDataUrl('alice@example.com')
    expect(first).toBe(second)
    expect(first.startsWith('data:image/svg+xml;utf8,')).toBe(true)
    expect(decodeURIComponent(first.split(',')[1])).toContain('<svg')
  })

  it('handles a null email without throwing', async () => {
    const url = await buildDicebearAvatarDataUrl(null)
    expect(url.startsWith('data:image/svg+xml;utf8,')).toBe(true)
  })
})

describe('storeDicebearAvatarAtSignup', () => {
  function makeAdminClient(overrides: {
    user?: Record<string, unknown> | null
    getUserError?: { message: string } | null
    updateError?: { message: string } | null
  } = {}) {
    const { user = { id: 'u1', email: 'alice@example.com', user_metadata: {} }, getUserError = null, updateError = null } = overrides
    return {
      auth: {
        admin: {
          getUserById: vi.fn().mockResolvedValue({
            data: { user },
            error: getUserError,
          }),
          updateUserById: vi.fn().mockResolvedValue({ error: updateError }),
        },
      },
    }
  }

  it('writes avatar_url + avatar_source dicebear for a fresh user', async () => {
    const client = makeAdminClient()
    await storeDicebearAvatarAtSignup(client, 'u1', 'alice@example.com')

    expect(client.auth.admin.updateUserById).toHaveBeenCalledTimes(1)
    const [userId, attrs] = client.auth.admin.updateUserById.mock.calls[0]
    expect(userId).toBe('u1')
    const metadata = attrs.user_metadata as Record<string, unknown>
    expect(metadata.avatar_source).toBe(AVATAR_SOURCE_DICEBEAR)
    expect(metadata.avatar_url).toContain('data:image/svg+xml;utf8,')
    expect(metadata.avatar_url).not.toContain('<svg')
  })

  it('preserves existing metadata when writing', async () => {
    const client = makeAdminClient({
      user: {
        id: 'u1',
        email: 'alice@example.com',
        user_metadata: { display_name: 'Alice', other: 'keep' },
      },
    })
    await storeDicebearAvatarAtSignup(client, 'u1', 'alice@example.com')

    const attrs = client.auth.admin.updateUserById.mock.calls[0][1]
    expect(attrs.user_metadata).toMatchObject({
      display_name: 'Alice',
      other: 'keep',
      avatar_source: 'dicebear',
    })
  })

  it('skips users that already have an avatar_url (e.g. OAuth signup)', async () => {
    const client = makeAdminClient({
      user: {
        id: 'u1',
        email: 'alice@example.com',
        user_metadata: { avatar_url: 'https://avatars.githubusercontent.com/u/1' },
      },
    })
    await storeDicebearAvatarAtSignup(client, 'u1', 'alice@example.com')

    expect(client.auth.admin.updateUserById).not.toHaveBeenCalled()
  })

  it('skips when the user cannot be read', async () => {
    const client = makeAdminClient({ getUserError: { message: 'nope' } })
    await storeDicebearAvatarAtSignup(client, 'u1', 'alice@example.com')

    expect(client.auth.admin.updateUserById).not.toHaveBeenCalled()
  })

  it('never throws when the metadata write fails', async () => {
    const client = makeAdminClient({ updateError: { message: 'write failed' } })
    await expect(
      storeDicebearAvatarAtSignup(client, 'u1', 'alice@example.com'),
    ).resolves.toBeUndefined()
    expect(client.auth.admin.updateUserById).toHaveBeenCalledTimes(1)
  })

  it('never throws when getUserById itself rejects', async () => {
    const client = makeAdminClient()
    client.auth.admin.getUserById.mockRejectedValue(new Error('network down'))
    await expect(
      storeDicebearAvatarAtSignup(client, 'u1', 'alice@example.com'),
    ).resolves.toBeUndefined()
  })
})

describe('writeOAuthAvatarSource', () => {
  function makeSessionClient() {
    return {
      auth: {
        updateUser: vi.fn().mockResolvedValue({ error: null }),
      },
    }
  }

  it('stamps the provider label when the OAuth avatar is present', async () => {
    const client = makeSessionClient()
    await writeOAuthAvatarSource(
      client,
      { user_metadata: { avatar_url: 'https://lh3.googleusercontent.com/me' } },
      'google',
    )

    expect(client.auth.updateUser).toHaveBeenCalledTimes(1)
    expect(client.auth.updateUser).toHaveBeenCalledWith({
      data: { avatar_source: 'google' },
    })
  })

  it('is idempotent: does not overwrite an existing avatar_source', async () => {
    const client = makeSessionClient()
    await writeOAuthAvatarSource(
      client,
      { user_metadata: { avatar_url: 'https://x/me.png', avatar_source: AVATAR_SOURCE_UPLOAD } },
      'github',
    )

    expect(client.auth.updateUser).not.toHaveBeenCalled()
  })

  it('does nothing when the user has no avatar_url', async () => {
    const client = makeSessionClient()
    await writeOAuthAvatarSource(client, { user_metadata: { name: 'Alice' } }, 'google')
    await writeOAuthAvatarSource(client, null, 'google')
    await writeOAuthAvatarSource(client, undefined, 'github')

    expect(client.auth.updateUser).not.toHaveBeenCalled()
  })

  it('does nothing when the source is null', async () => {
    const client = makeSessionClient()
    await writeOAuthAvatarSource(
      client,
      { user_metadata: { avatar_url: 'https://x/me.png' } },
      null,
    )

    expect(client.auth.updateUser).not.toHaveBeenCalled()
  })

  it('never throws when the write fails', async () => {
    const client = makeSessionClient()
    client.auth.updateUser.mockResolvedValue({ error: { message: 'boom' } })
    await expect(
      writeOAuthAvatarSource(
        client,
        { user_metadata: { avatar_url: 'https://x/me.png' } },
        'github',
      ),
    ).resolves.toBeUndefined()
    expect(client.auth.updateUser).toHaveBeenCalledTimes(1)
  })
})
