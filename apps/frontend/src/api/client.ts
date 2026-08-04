// src/api/client.ts
import type {
  Project,
  Folder,
  Ticket,
  Session,
  Brainstorm,
  Template,
  Artifact,
  CreateBrainstormResponse,
  BrainstormPendingResponse,
  BrainstormMessagesResponse,
  TemplatePhase,
  SessionLogEntry,
  ConversationEntry,
  TicketPendingResponse,
  TicketMessagesResponse,
  Task,
  TaskComment,
  ArtifactChatStartResponse,
  ArtifactChatPendingResponse,
  ArchiveResult,
  WorkerTreeResponse,
  EpicWithCounts,
  EpicWithTickets,
} from '@potato-cannon/shared'

const BASE_URL = ''

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers
    }
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(error.message || error.error || 'Request failed')
  }

  // Handle empty responses (e.g., DELETE returning void)
  const text = await response.text()
  return text ? JSON.parse(text) : (null as T)
}

export const api = {
  // ============ Projects ============

  getProjects: () =>
    request<Project[]>('/api/projects'),

  addProject: (path: string, displayName?: string | null, template?: string | null) =>
    request<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ path, displayName, template })
    }),

  deleteProject: (id: string) =>
    request<void>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    }),

  updateProject: (id: string, updates: { displayName?: string; icon?: string; color?: string; swimlaneColors?: Record<string, string>; wipLimits?: Record<string, number> | null; branchPrefix?: string; folderId?: string | null }) =>
    request<Project>(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    }),

  toggleAutomatedPhase: (projectId: string, phaseId: string, automated: boolean) =>
    request<Project>(`/api/projects/${encodeURIComponent(projectId)}/automated-phases`, {
      method: 'PATCH',
      body: JSON.stringify({ phaseId, automated })
    }),

  // ============ Folders ============

  getFolders: () =>
    request<Folder[]>('/api/folders'),

  createFolder: (name: string) =>
    request<Folder>('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ name })
    }),

  renameFolder: (id: string, name: string) =>
    request<Folder>(`/api/folders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name })
    }),

  deleteFolder: (id: string) =>
    request<void>(`/api/folders/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    }),

  // ============ Tickets ============

  getTickets: (projectId: string, phase?: string) => {
    const url = phase
      ? `/api/tickets/${encodeURIComponent(projectId)}?phase=${encodeURIComponent(phase)}`
      : `/api/tickets/${encodeURIComponent(projectId)}`
    return request<Ticket[]>(url)
  },

  getTicket: (projectId: string, ticketId: string) =>
    request<Ticket>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}`),

  createTicket: (projectId: string, title: string, description?: string, ticketNumber?: string, epicId?: string) =>
    request<Ticket>(`/api/tickets/${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        description,
        ...(ticketNumber ? { ticketNumber } : {}),
        ...(epicId ? { epicId } : {}),
      })
    }),

  updateTicket: (projectId: string, ticketId: string, updates: Partial<Ticket> & { force?: boolean }) =>
    request<Ticket>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    }),

  deleteTicket: (projectId: string, ticketId: string) =>
    request<void>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}`, {
      method: 'DELETE'
    }),

  archiveTicket: (projectId: string, ticketId: string) =>
    request<ArchiveResult>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/archive`, {
      method: 'PATCH'
    }),

  restoreTicket: (projectId: string, ticketId: string) =>
    request<Ticket>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/restore`, {
      method: 'PATCH'
    }),

  restartTicketToPhase: (projectId: string, ticketId: string, targetPhase: string) =>
    request<{
      success: boolean;
      ticket: Ticket;
      sessionSpawned: boolean;
      cleanup: {
        sessionsDeleted: number;
        tasksDeleted: number;
        feedbackDeleted: number;
        historyEntriesDeleted: number;
        worktreeRemoved: boolean;
      };
    }>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/restart`, {
      method: 'POST',
      body: JSON.stringify({ targetPhase })
    }),

  getArchivedTickets: (projectId: string) =>
    request<Ticket[]>(`/api/tickets/${encodeURIComponent(projectId)}?archived=true`),

  // ============ Ticket Images ============

  getTicketImages: (projectId: string, ticketId: string) =>
    request<string[]>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/images`),

  uploadImage: async (projectId: string, ticketId: string, file: File) => {
    const formData = new FormData()
    formData.append('image', file)
    const response = await fetch(
      `/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/images`,
      { method: 'POST', body: formData }
    )
    if (!response.ok) throw new Error('Upload failed')
    return response.json() as Promise<{ name: string }>
  },

  deleteImage: (projectId: string, ticketId: string, filename: string) =>
    request<void>(
      `/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/images/${encodeURIComponent(filename)}`,
      { method: 'DELETE' }
    ),

  // ============ Ticket Artifacts ============

  getTicketArtifacts: (projectId: string, ticketId: string) =>
    request<Artifact[]>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/artifacts`),

  getTicketArtifact: async (projectId: string, ticketId: string, filename: string) => {
    const response = await fetch(
      `/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/artifacts/${encodeURIComponent(filename)}`
    )
    if (!response.ok) throw new Error('Artifact not found')
    return response.text()
  },

  updateTicketArtifact: (projectId: string, ticketId: string, filename: string, content: string) =>
    request<{ ok: true; filename: string; isNewVersion: boolean; wroteThrough: boolean | null }>(
      `/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/artifacts/${encodeURIComponent(filename)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }
    ),

  // ============ Ticket Conversations ============

  getTicketConversations: (projectId: string, ticketId: string) =>
    request<ConversationEntry[]>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/conversations`),

  getTicketMessages: (projectId: string, ticketId: string) =>
    request<TicketMessagesResponse>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/messages`),

  getTicketPending: (projectId: string, ticketId: string) =>
    request<TicketPendingResponse>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/pending`),

  sendTicketInput: (projectId: string, ticketId: string, message: string) =>
    request<void>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/input`, {
      method: 'POST',
      body: JSON.stringify({ message })
    }),

  getTicketTasks: (projectId: string, ticketId: string, phase?: string) =>
    request<Task[]>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/tasks${phase ? `?phase=${encodeURIComponent(phase)}` : ''}`),

  getTaskComments: (projectId: string, ticketId: string, taskId: string) =>
    request<TaskComment[]>(`/api/tickets/${encodeURIComponent(projectId)}/${ticketId}/tasks/${taskId}/comments`),

  // ============ Sessions ============

  getSessions: () =>
    request<Session[]>('/api/sessions'),

  getSessionLog: (sessionId: string) =>
    request<SessionLogEntry[]>(`/api/sessions/${sessionId}`),

  stopSession: (sessionId: string) =>
    request<void>(`/api/sessions/${sessionId}/stop`, { method: 'POST' }),

  // ============ Phases ============

  getPhases: () =>
    request<string[]>('/api/phases'),

  getProjectPhases: (projectId: string) =>
    request<string[]>(`/api/projects/${encodeURIComponent(projectId)}/phases`),

  // ============ Brainstorms ============

  getBrainstorms: (projectId: string) =>
    request<Brainstorm[]>(`/api/brainstorms/${encodeURIComponent(projectId)}`),

  getBrainstorm: (projectId: string, brainstormId: string) =>
    request<Brainstorm>(`/api/brainstorms/${encodeURIComponent(projectId)}/${brainstormId}`),

  createBrainstorm: (projectId: string, options?: { name?: string | null; initialMessage?: string }) =>
    request<CreateBrainstormResponse>(`/api/brainstorms/${encodeURIComponent(projectId)}`, {
      method: 'POST',
      body: JSON.stringify(options ?? {})
    }),

  resumeBrainstorm: (projectId: string, brainstormId: string) =>
    request<CreateBrainstormResponse>(
      `/api/brainstorms/${encodeURIComponent(projectId)}/${brainstormId}/resume`,
      { method: 'POST' }
    ),

  sendBrainstormInput: (projectId: string, brainstormId: string, message: string) =>
    request<void>(`/api/brainstorms/${encodeURIComponent(projectId)}/${brainstormId}/input`, {
      method: 'POST',
      body: JSON.stringify({ message })
    }),

  getBrainstormPending: (projectId: string, brainstormId: string) =>
    request<BrainstormPendingResponse>(
      `/api/brainstorms/${encodeURIComponent(projectId)}/${brainstormId}/pending`
    ),

  getBrainstormMessages: (projectId: string, brainstormId: string) =>
    request<BrainstormMessagesResponse>(
      `/api/brainstorms/${encodeURIComponent(projectId)}/${brainstormId}/messages`
    ),

  deleteBrainstorm: (projectId: string, brainstormId: string) =>
    request<void>(
      `/api/brainstorms/${encodeURIComponent(projectId)}/${brainstormId}`,
      { method: 'DELETE' }
    ),

  // ============ Templates ============

  getTemplates: () =>
    request<Template[]>('/api/templates'),

  getTemplate: (name: string) =>
    request<Template>(`/api/templates/${encodeURIComponent(name)}`),

  getTemplateFull: (name: string) =>
    request<Template>(`/api/templates/${encodeURIComponent(name)}?full=true`),

  createTemplate: (name: string, description: string, phases: TemplatePhase[] = []) =>
    request<Template>('/api/templates', {
      method: 'POST',
      body: JSON.stringify({ name, description, phases })
    }),

  updateTemplate: (name: string, updates: Partial<Template>) =>
    request<Template>(`/api/templates/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    }),

  deleteTemplate: (name: string) =>
    request<void>(`/api/templates/${encodeURIComponent(name)}`, {
      method: 'DELETE'
    }),

  setDefaultTemplate: (name: string) =>
    request<void>(`/api/templates/${encodeURIComponent(name)}/default`, {
      method: 'POST'
    }),

  // ============ Project Template ============

  setProjectTemplate: (projectId: string, templateName: string) =>
    request<void>(`/api/projects/${encodeURIComponent(projectId)}/template`, {
      method: 'PUT',
      body: JSON.stringify({ name: templateName })
    }),

  getProjectTemplateStatus: (projectId: string) =>
    request<{
      current: string | null;
      available: string | null;
      upgradeType: 'major' | 'minor' | 'patch' | null;
    }>(`/api/projects/${encodeURIComponent(projectId)}/template-status`),

  // ============ Agent Prompts ============

  getAgentPrompt: async (templateName: string, agentPath: string) => {
    const response = await fetch(
      `/api/templates/${encodeURIComponent(templateName)}/${agentPath}`
    )
    if (!response.ok) throw new Error('Agent not found')
    return response.text()
  },

  saveAgentPrompt: (templateName: string, agentPath: string, content: string) =>
    fetch(`/api/templates/${encodeURIComponent(templateName)}/${agentPath}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: content
    }).then(r => {
      if (!r.ok) throw new Error('Failed to save agent prompt')
      return r.json()
    }),

  // ============ Artifact Chat ============

  startArtifactChat: (projectId: string, ticketId: string, artifact: string, message: string) =>
    request<ArtifactChatStartResponse>(
      `/api/artifact-chat/${encodeURIComponent(projectId)}/${ticketId}/${encodeURIComponent(artifact)}/start`,
      {
        method: 'POST',
        body: JSON.stringify({ message })
      }
    ),

  getArtifactChatPending: (projectId: string, ticketId: string, artifact: string, contextId: string) =>
    request<ArtifactChatPendingResponse>(
      `/api/artifact-chat/${encodeURIComponent(projectId)}/${ticketId}/${encodeURIComponent(artifact)}/pending?contextId=${encodeURIComponent(contextId)}`
    ),

  sendArtifactChatInput: (projectId: string, ticketId: string, artifact: string, contextId: string, message: string) =>
    request<{ ok: true }>(
      `/api/artifact-chat/${encodeURIComponent(projectId)}/${ticketId}/${encodeURIComponent(artifact)}/input`,
      {
        method: 'POST',
        body: JSON.stringify({ contextId, message })
      }
    ),

  endArtifactChat: (projectId: string, ticketId: string, artifact: string, contextId: string) =>
    request<{ ok: true }>(
      `/api/artifact-chat/${encodeURIComponent(projectId)}/${ticketId}/${encodeURIComponent(artifact)}/end`,
      {
        method: 'POST',
        body: JSON.stringify({ contextId })
      }
    ),

  // ============ Template Versioning ============

  getTemplateStatus: (projectId: string) =>
    request<{
      current: string | null;
      available: string | null;
      upgradeType: 'major' | 'minor' | 'patch' | null;
    }>(`/api/projects/${encodeURIComponent(projectId)}/template-status`),

  upgradeTemplate: (projectId: string, force?: boolean) =>
    request<{
      upgraded: boolean;
      previousVersion?: string;
      newVersion?: string;
      upgradeType?: 'major' | 'minor' | 'patch';
      message?: string;
      error?: string;
      ticketsToReset?: Array<{ id: string; title: string; phase: string }>;
    }>(`/api/projects/${encodeURIComponent(projectId)}/upgrade-template`, {
      method: 'POST',
      body: JSON.stringify({ force })
    }),

  getTemplateChangelog: (projectId: string) =>
    request<{ changelog: string | null }>(`/api/projects/${encodeURIComponent(projectId)}/template-changelog`),

  // ============ Phase Workers ============

  getPhaseWorkers: (projectId: string, phase: string) =>
    request<WorkerTreeResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/phases/${encodeURIComponent(phase)}/workers`
    ),

  // ============ Agent Overrides ============

  getAgentDefault: (projectId: string, agentType: string) =>
    request<{ content: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentType)}/default`
    ),

  getAgentOverride: (projectId: string, agentType: string) =>
    request<{ content: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentType)}/override`
    ),

  saveAgentOverride: (projectId: string, agentType: string, content: string) =>
    request<{ ok: true }>(
      `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentType)}/override`,
      {
        method: 'PUT',
        body: JSON.stringify({ content })
      }
    ),

  deleteAgentOverride: (projectId: string, agentType: string) =>
    request<{ ok: true }>(
      `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentType)}/override`,
      { method: 'DELETE' }
    ),

  // ============ Epics ============

  getEpics: (projectId: string) =>
    request<EpicWithCounts[]>(`/api/projects/${encodeURIComponent(projectId)}/epics`),

  getEpic: (projectId: string, epicId: string) =>
    request<EpicWithTickets>(`/api/projects/${encodeURIComponent(projectId)}/epics/${encodeURIComponent(epicId)}`),

  createEpic: (projectId: string, title: string, description?: string) =>
    request<EpicWithCounts>(`/api/projects/${encodeURIComponent(projectId)}/epics`, {
      method: 'POST',
      body: JSON.stringify({ title, description }),
    }),

  updateEpic: (projectId: string, epicId: string, updates: { title?: string; description?: string }) =>
    request<EpicWithCounts>(`/api/projects/${encodeURIComponent(projectId)}/epics/${encodeURIComponent(epicId)}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),

  deleteEpic: (projectId: string, epicId: string) =>
    request<{ success: true }>(`/api/projects/${encodeURIComponent(projectId)}/epics/${encodeURIComponent(epicId)}`, {
      method: 'DELETE',
    }),

  assignTicketToEpic: (projectId: string, ticketId: string, epicId: string | null) =>
    request<{ success: true }>(`/api/projects/${encodeURIComponent(projectId)}/tickets/${encodeURIComponent(ticketId)}/epic`, {
      method: 'PUT',
      body: JSON.stringify({ epicId }),
    }),

  // ============ Epic Chat ============

  sendEpicChatMessage: (projectId: string, epicId: string, message: string) =>
    request<{ ok: true; sessionId: string }>(
      `/api/projects/${encodeURIComponent(projectId)}/epics/${encodeURIComponent(epicId)}/chat`,
      {
        method: 'POST',
        body: JSON.stringify({ message }),
      }
    ),

  getEpicChatMessages: (projectId: string, epicId: string) =>
    request<{ messages: Array<{ id: string; type: string; text: string; timestamp: string; conversationId: string; options?: string[] }> }>(
      `/api/projects/${encodeURIComponent(projectId)}/epics/${encodeURIComponent(epicId)}/chat/messages`
    ),
}
