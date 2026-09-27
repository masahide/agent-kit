package codex

import (
	"context"
	"encoding/json"
	"fmt"
)

// client is a JSON-RPC client over one WebSocket connection. Notifications
// and requests from the server are read and dropped: agentctl only asks.
type client struct {
	ws   *wsConn
	next int
	stop func() bool
}

// RPCError is an error answer from the daemon.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string { return fmt.Sprintf("%s (code %d)", e.Message, e.Code) }

type rpcMessage struct {
	ID     *json.RawMessage `json:"id"`
	Method string           `json:"method"`
	Result json.RawMessage  `json:"result"`
	Error  *RPCError        `json:"error"`
}

const clientVersion = "0.1.0"

func connect(ctx context.Context, socket string) (*client, error) {
	ws, err := dialWS(ctx, socket)
	if err != nil {
		return nil, err
	}
	// Cancelling the command (Ctrl+C) unblocks a read in progress.
	c := &client{ws: ws, stop: context.AfterFunc(ctx, func() { _ = ws.c.Close() })}
	init := map[string]any{"clientInfo": map[string]string{"name": "agentctl", "version": clientVersion}}
	if err := c.call("initialize", init, nil); err != nil {
		c.close()
		return nil, err
	}
	if err := c.notify("initialized"); err != nil {
		c.close()
		return nil, err
	}
	return c, nil
}

func (c *client) close() {
	c.stop()
	c.ws.close()
}

func (c *client) notify(method string) error {
	b, _ := json.Marshal(map[string]any{"method": method})
	return c.ws.writeText(b)
}

// call sends one request and decodes its result into out (if out is not nil).
func (c *client) call(method string, params any, out any) error {
	c.next++
	id := c.next
	req := map[string]any{"id": id, "method": method}
	if params != nil {
		req["params"] = params
	}
	b, err := json.Marshal(req)
	if err != nil {
		return err
	}
	if err := c.ws.writeText(b); err != nil {
		return err
	}
	for {
		raw, err := c.ws.readMessage()
		if err != nil {
			return err
		}
		var m rpcMessage
		if json.Unmarshal(raw, &m) != nil || m.ID == nil || m.Method != "" {
			continue // a notification or a request from the server
		}
		var got int
		if json.Unmarshal(*m.ID, &got) != nil || got != id {
			continue
		}
		if m.Error != nil {
			return m.Error
		}
		if out != nil {
			return json.Unmarshal(m.Result, out)
		}
		return nil
	}
}

// callRaw returns the result as it is, for `raw codex`.
func (c *client) callRaw(method string, params json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	if err := c.call(method, params, &out); err != nil {
		return nil, err
	}
	return out, nil
}
