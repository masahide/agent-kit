/**
 * 共有ディレクトリのファイルの見本。fixtures/protocol/*.json と同じ中身です。
 *
 * Mod のテストは JSON を import できないので、同じ中身をここに 1 行ずつ置きます。
 * ずれは Go のテスト (tools/agentctl/internal/claude の TestProtocolFixtures) が見つけます。
 */

export const ackDropped = {"v":1,"id":"1790498063477-8dd10162","status":"dropped","detail":"the session is shutting down","at":1790498063600}
export const ackQueued = {"v":1,"id":"1790498063477-8dd10162","status":"queued","at":1790498063600}
export const inboxInterrupt = {"v":1,"id":"1790498063999-0a1b2c3d","kind":"interrupt","createdAt":1790498063999}
export const inboxPrompt = {"v":1,"id":"1790498063477-8dd10162","kind":"prompt","text":"run the tests again","createdAt":1790498063477}
export const meta = {"v":1,"name":"e2e","archived":true,"updatedAt":1790498100000}
export const mod = {"v":1,"sessionId":"afa924ff-7fba-43b4-9122-4e9a06fc2f09","pid":4242,"modVersion":"0.1.0","startedAt":1790498000000}
