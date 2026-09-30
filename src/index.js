import { verifyToken } from './auth.js';
import { handleLogin, handleRegister, handleChangePassword } from './accounts.js';
import { json } from './util.js';
import {
  handleListProviders, handleSaveProvider, handleEnableProvider,
  handleDeleteProvider, handleTestProvider,
} from './providers.js';
import {
  handleListConversations, handleConversationMessages,
  handleDeleteConversation, handleRenameConversation, handleRollback,
  handleClearConversations,
} from './conversations.js';
import { handleChat } from './chat.js';
import {
  handleListMcpServers, handleSaveMcpServer, handleDeleteMcpServer,
  handleToggleMcpServer, handleTestMcpServer,
} from './mcp-servers.js';
import { handleGetSettings, handlePutSettings } from './settings.js';
import { handleSaveNote } from './notes.js';
import { handleExportDoc } from './export.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const [resource, id, sub] = url.pathname.slice(5).split('/').filter(Boolean);
    const m = request.method;

    if (m === 'POST' && resource === 'auth' && id === 'login') return handleLogin(request, env);
    if (m === 'POST' && resource === 'auth' && id === 'register') return handleRegister(request, env);

    const userId = await verifyToken(bearer(request), env);
    if (!userId) return json({ error: 'unauthorized' }, 401);

    if (m === 'GET' && resource === 'auth') return json({ userId });
    if (m === 'POST' && resource === 'auth' && id === 'password') return handleChangePassword(request, env, userId);

    if (resource === 'providers') {
      if (m === 'GET' && !id) return handleListProviders(env, userId);
      if (m === 'POST' && !id) return handleSaveProvider(request, env, userId, null);
      if (m === 'PUT' && id) return handleSaveProvider(request, env, userId, id);
      if (m === 'DELETE' && id) return handleDeleteProvider(env, userId, id);
      if (m === 'POST' && id && sub === 'enable') return handleEnableProvider(env, userId, id);
      if (m === 'POST' && id && sub === 'test') return handleTestProvider(env, userId, id);
    }

    if (resource === 'conversations') {
      if (m === 'GET' && !id) return handleListConversations(env, userId);
      if (m === 'DELETE' && !id) return handleClearConversations(env, userId);
      if (m === 'GET' && id && sub === 'messages') return handleConversationMessages(env, userId, id, url);
      if (m === 'POST' && id && sub === 'rollback') return handleRollback(request, env, userId, id);
      if (m === 'PATCH' && id) return handleRenameConversation(request, env, userId, id);
      if (m === 'DELETE' && id) return handleDeleteConversation(env, userId, id);
    }

    if (resource === 'mcp-servers') {
      if (m === 'GET' && !id) return handleListMcpServers(env, userId);
      if (m === 'POST' && !id) return handleSaveMcpServer(request, env, userId, null);
      if (m === 'PUT' && id) return handleSaveMcpServer(request, env, userId, id);
      if (m === 'DELETE' && id) return handleDeleteMcpServer(env, userId, id);
      if (m === 'POST' && id && sub === 'enable') return handleToggleMcpServer(env, userId, id, true);
      if (m === 'POST' && id && sub === 'disable') return handleToggleMcpServer(env, userId, id, false);
      if (m === 'POST' && id && sub === 'test') return handleTestMcpServer(env, userId, id);
    }

    if (m === 'POST' && resource === 'chat' && !id) return handleChat(request, env, ctx, userId);

    if (resource === 'settings') {
      if (m === 'GET' && !id) return handleGetSettings(env, userId);
      if (m === 'PUT' && !id) return handlePutSettings(request, env, userId);
    }

    if (m === 'POST' && resource === 'note' && !id) return handleSaveNote(request, env, userId);
    if (m === 'POST' && resource === 'export' && !id) return handleExportDoc(request, env, userId);

    return json({ error: 'not found' }, 404);
  },
};

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
