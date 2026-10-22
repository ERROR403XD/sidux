import { describe, expect, it } from 'vitest'
import { sanitizeCustomConnectionPayload, sanitizeCustomConnectionRequest, type PayloadModelCapability } from './customConnectionPayload'

function model(overrides: Partial<PayloadModelCapability> = {}): PayloadModelCapability {
  return {
    id: 'fixture-model',
    efforts: [{ value: 'medium' }],
    serviceTiers: [{ value: 'priority' }],
    ...overrides,
  }
}

describe('sanitizeCustomConnectionPayload', () => {
  it('keeps reasoning and service tier fields when the selected model declares them', () => {
    const payload = sanitizeCustomConnectionPayload(
      { model: 'fixture-model', reasoning: { effort: 'medium' }, reasoning_effort: 'medium', service_tier: 'priority' },
      [model()],
    )

    expect(payload).toEqual({ model: 'fixture-model', reasoning: { effort: 'medium' }, reasoning_effort: 'medium', service_tier: 'priority' })
  })

  it('removes unsupported capability fields and preserves unknown business fields', () => {
    const payload = sanitizeCustomConnectionPayload(
      { model: 'fixture-model', reasoning: { effort: 'medium' }, reasoning_effort: 'medium', service_tier: 'priority', metadata: { keep: true } },
      [model({ efforts: [], serviceTiers: [] })],
    )

    expect(payload).toEqual({ model: 'fixture-model', metadata: { keep: true } })
  })

  it('uses the model selected by the caller rather than connection defaults', () => {
    const payload = sanitizeCustomConnectionPayload(
      { model: 'other-model', reasoning_effort: 'medium', service_tier: 'priority' },
      [model(), model({ id: 'other-model', efforts: null, serviceTiers: null })],
    )

    expect(payload).toEqual({ model: 'other-model' })
  })

  it('does not mutate the input payload', () => {
    const input = { model: 'fixture-model', reasoning_effort: 'medium', service_tier: 'priority' }

    sanitizeCustomConnectionPayload(input, [model({ efforts: [], serviceTiers: [] })])

    expect(input).toEqual({ model: 'fixture-model', reasoning_effort: 'medium', service_tier: 'priority' })
  })
})

describe('sanitizeCustomConnectionRequest', () => {
  it('only forwards unadvertised priority with explicit connection opt-in', () => {
    const connection = { model: 'fixture-model', models: [model({ efforts: [], serviceTiers: [] })] }
    const payload = { service_tier: 'priority', reasoning_effort: 'high', metadata: 'keep' }
    expect(sanitizeCustomConnectionRequest(payload, connection)).toEqual({ model: 'fixture-model', metadata: 'keep' })
    expect(sanitizeCustomConnectionRequest(payload, { ...connection, allowFast: true })).toEqual({ model: 'fixture-model', service_tier: 'priority', metadata: 'keep' })
    expect(sanitizeCustomConnectionRequest({ ...payload, service_tier: 'unsupported' }, { ...connection, allowFast: true })).not.toHaveProperty('service_tier')
  })
  it.each([{ serviceTiers: [] }, { serviceTiers: [{ value: 'standard' }] }])('keeps opt-out protection for manual and standard-only models ($serviceTiers)', ({ serviceTiers }) => {
    const connection = { model: 'fixture-model', models: [model({ serviceTiers })], manualModels: ['manual-model'] }
    for (const id of ['fixture-model', 'manual-model']) {
      const payload = { model: id, service_tier: 'priority' }
      expect(sanitizeCustomConnectionRequest(payload, connection)).not.toHaveProperty('service_tier')
      expect(sanitizeCustomConnectionRequest(payload, { ...connection, allowFast: true })).toMatchObject(payload)
    }
    expect(sanitizeCustomConnectionRequest({ service_tier: 'standard' }, connection).service_tier).toBe(serviceTiers.length ? 'standard' : undefined)
  })
  it('resolves an omitted model from the connection default before capability checks', () => {
    const payload = sanitizeCustomConnectionRequest(
      { reasoning_effort: 'medium', service_tier: 'priority', metadata: 'keep' },
      { model: 'fixture-model', models: [model()] },
    )

    expect(payload).toEqual({
      model: 'fixture-model',
      reasoning_effort: 'medium',
      service_tier: 'priority',
      metadata: 'keep',
    })
  })

  it('does not synthesize capabilities for models outside the catalog', () => {
    const payload = sanitizeCustomConnectionRequest(
      { model: 'unlisted', reasoning_effort: 'medium', service_tier: 'priority' },
      { model: 'fixture-model', models: [model()] },
    )

    expect(payload).toEqual({ model: 'unlisted' })
  })

  it('keeps custom payload fields for models listed in the local manual catalog', () => {
    const payload = sanitizeCustomConnectionRequest(
      { model: 'manual-model', reasoning_effort: 'medium', service_tier: 'priority', metadata: 'keep' },
      { model: 'fixture-model', models: [model()], manualModels: ['manual-model'], reasoningEfforts: ['medium'], allowFast: true },
    )

    expect(payload).toEqual({ model: 'manual-model', reasoning_effort: 'medium', service_tier: 'priority', metadata: 'keep' })
  })

  it('strips reasoning for local-only models until a connection-level probe confirms it', () => {
    const payload = sanitizeCustomConnectionRequest(
      { model: 'manual-model', reasoning_effort: 'medium', service_tier: 'priority' },
      { model: 'fixture-model', models: [model()], manualModels: ['manual-model'] },
    )

    expect(payload).toEqual({ model: 'manual-model' })
  })

  it('uses the same request contract for the API outlet and Codex runtime route', () => {
    const connection = { model: 'fixture-model', models: [model()], manualModels: [] }
    const expected = { model: 'fixture-model', reasoning_effort: 'medium', service_tier: 'priority' }

    expect(sanitizeCustomConnectionRequest({ model: 'fixture-model', reasoning_effort: 'medium', service_tier: 'priority' }, connection)).toEqual(expected)
    expect(sanitizeCustomConnectionRequest({ reasoning_effort: 'medium', service_tier: 'priority' }, connection)).toEqual(expected)
  })
})
