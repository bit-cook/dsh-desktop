import { describe, expect, it } from 'vitest'
import { EnterpriseLlmAdapter, serializeEnterpriseRequest } from '../packages/dsh-desktop-enterprise/openai.js'
import { parseModels } from '../packages/dsh-desktop-enterprise/contract.js'

const model = { id: 'bisheng:42', object: 'model', created: 0, owned_by: 'bisheng', display_name: 'Vision',
  capabilities: { streaming: true, tools: true, reasoning_content: false, vision: true } }
const ref = { attachmentId: 'image-1' }
const options = { model: model.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe' }, { type: 'image', attachment: ref }] }] }

describe('Enterprise image input', () => {
  it('preserves inline image blocks only for enabled models', () => {
    const url = 'data:image/png;base64,aW1hZ2U='
    expect(serializeEnterpriseRequest(options, model, new Map([['image-1', url]])).messages[0].content[1])
      .toEqual({ type: 'image_url', image_url: { url } })
    expect(() => serializeEnterpriseRequest(options, { ...model, capabilities: { ...model.capabilities, vision: false } }))
      .toThrow()
  })
  it('advertises image input and reads attachment bytes before calling enterprise API', async () => {
    let request
    const adapter = new EnterpriseLlmAdapter({ models: () => [model], providerName: () => 'Enterprise',
      readImage: async (received) => { expect(received).toEqual(ref); return { mediaType: 'image/png', data: Buffer.from('image') } },
      request: async (body) => { request = body; throw new Error('test stop') } })
    expect((await adapter.listModels('enterprise'))[0].inputModalities).toEqual(['text', 'image'])
    await expect(adapter.stream(options).next()).rejects.toThrow('test stop')
    expect(request.messages[0].content[1].image_url.url).toBe('data:image/png;base64,aW1hZ2U=')
  })
  it('keeps older servers text-only and rejects malformed capability values', () => {
    const old = { ...model, capabilities: { ...model.capabilities, vision: undefined } }
    expect(parseModels({ object: 'list', data: [old] })[0].capabilities.vision).toBe(false)
    expect(() => parseModels({ object: 'list', data: [{ ...model, capabilities: { ...model.capabilities, vision: 'true' } }] })).toThrow()
  })
})
