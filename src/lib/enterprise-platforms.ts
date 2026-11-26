// Enterprise platform recipes: one entry per native action the model can call.
// Each entry becomes a real tool through connector-sdk; growing coverage is
// data entry, not glue code. Auth quirks are documented on the recipe.
import type { PlatformRecipe } from "@/lib/connector-sdk";

export const githubRecipe: PlatformRecipe = {
  id: "github",
  name: "GitHub",
  baseUrl: "https://api.github.com",
  // REST API v2022-11-28: bearer token plus the versioned media type.
  auth: ({ token: t }) => ({
    authorization: `Bearer ${t}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  }),
  actions: [
    { id: "search_issues", description: "Search issues and pull requests across repositories.", method: "GET", path: "https://api.github.com/search/issues", params: [{ name: "q", type: "string", description: "Search query", required: true }, { name: "per_page", type: "number", description: "Results per page (max 100)" }] },
    { id: "search_repositories", description: "Search repositories by keyword.", method: "GET", path: "https://api.github.com/search/repositories", params: [{ name: "q", type: "string", description: "Search query", required: true }] },
    { id: "get_repo", description: "Get a repository's metadata.", method: "GET", path: "https://api.github.com/repos/{owner}/{repo}", params: [{ name: "owner", type: "string", description: "Repository owner", required: true }, { name: "repo", type: "string", description: "Repository name", required: true }] },
    { id: "list_issues", description: "List issues for a repository.", method: "GET", path: "https://api.github.com/repos/{owner}/{repo}/issues", params: [{ name: "owner", type: "string", description: "Repository owner", required: true }, { name: "repo", type: "string", description: "Repository name", required: true }, { name: "state", type: "string", description: "open, closed or all" }] },
    { id: "create_issue", description: "Create an issue in a repository.", method: "POST", path: "https://api.github.com/repos/{owner}/{repo}/issues", params: [{ name: "owner", type: "string", description: "Repository owner", required: true }, { name: "repo", type: "string", description: "Repository name", required: true }, { name: "title", type: "string", description: "Issue title", required: true }, { name: "body", type: "string", description: "Issue body" }], bodyParams: ["title", "body"] },
    { id: "add_issue_comment", description: "Comment on an issue or pull request.", method: "POST", path: "https://api.github.com/repos/{owner}/{repo}/issues/{issue_number}/comments", params: [{ name: "owner", type: "string", description: "Repository owner", required: true }, { name: "repo", type: "string", description: "Repository name", required: true }, { name: "issue_number", type: "number", description: "Issue or PR number", required: true }, { name: "body", type: "string", description: "Comment text", required: true }], bodyParams: ["body"] },
    { id: "list_pull_requests", description: "List pull requests for a repository.", method: "GET", path: "https://api.github.com/repos/{owner}/{repo}/pulls", params: [{ name: "owner", type: "string", description: "Repository owner", required: true }, { name: "repo", type: "string", description: "Repository name", required: true }] },
    { id: "create_pull_request", description: "Open a pull request from a head branch into a base branch.", method: "POST", path: "https://api.github.com/repos/{owner}/{repo}/pulls", params: [{ name: "owner", type: "string", description: "Repository owner", required: true }, { name: "repo", type: "string", description: "Repository name", required: true }, { name: "title", type: "string", description: "PR title", required: true }, { name: "head", type: "string", description: "Source branch", required: true }, { name: "base", type: "string", description: "Target branch", required: true }], bodyParams: ["title", "head", "base"] },
    { id: "list_commits", description: "List recent commits on a branch.", method: "GET", path: "https://api.github.com/repos/{owner}/{repo}/commits", params: [{ name: "owner", type: "string", description: "Repository owner", required: true }, { name: "repo", type: "string", description: "Repository name", required: true }, { name: "sha", type: "string", description: "Branch or sha" }] },
    { id: "get_commit", description: "Read one commit's message and file changes.", method: "GET", path: "https://api.github.com/repos/{owner}/{repo}/commits/{ref}", params: [{ name: "owner", type: "string", description: "Repository owner", required: true }, { name: "repo", type: "string", description: "Repository name", required: true }, { name: "ref", type: "string", description: "Commit sha or branch", required: true }] },
    { id: "get_file", description: "Read a file's metadata and download info from a repository.", method: "GET", path: "https://api.github.com/repos/{owner}/{repo}/contents/{path}", params: [{ name: "owner", type: "string", description: "Repository owner", required: true }, { name: "repo", type: "string", description: "Repository name", required: true }, { name: "path", type: "string", description: "File path", required: true }] },
    { id: "list_workflows", description: "List GitHub Actions workflow runs for a repository.", method: "GET", path: "https://api.github.com/repos/{owner}/{repo}/actions/runs", params: [{ name: "owner", type: "string", description: "Repository owner", required: true }, { name: "repo", type: "string", description: "Repository name", required: true }] },
  ],
};

export const slackRecipe: PlatformRecipe = {
  id: "slack",
  name: "Slack",
  baseUrl: "https://slack.com/api",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "search_messages", description: "Search workspace messages.", method: "GET", path: "https://slack.com/api/search.messages", params: [{ name: "query", type: "string", description: "Search query", required: true }] },
    { id: "post_message", description: "Post a message to a channel.", method: "POST", path: "https://slack.com/api/chat.postMessage", params: [{ name: "channel", type: "string", description: "Channel ID or name", required: true }, { name: "text", type: "string", description: "Message text", required: true }], bodyParams: ["channel", "text"] },
    { id: "list_channels", description: "List channels the token can see.", method: "GET", path: "https://slack.com/api/conversations.list", params: [] },
    { id: "get_channel_history", description: "Read recent messages from a channel.", method: "GET", path: "https://slack.com/api/conversations.history", params: [{ name: "channel", type: "string", description: "Channel ID", required: true }, { name: "limit", type: "number", description: "Messages to fetch (max 200)" }] },
    { id: "list_users", description: "List workspace members.", method: "GET", path: "https://slack.com/api/users.list", params: [] },
    { id: "get_user", description: "Look up a member by id.", method: "GET", path: "https://slack.com/api/users.info", params: [{ name: "user", type: "string", description: "User id", required: true }] },
    { id: "add_reaction", description: "React to a message with an emoji.", method: "POST", path: "https://slack.com/api/reactions.add", params: [{ name: "channel", type: "string", description: "Channel id", required: true }, { name: "timestamp", type: "string", description: "Message timestamp", required: true }, { name: "name", type: "string", description: "Emoji name, e.g. white_check_mark", required: true }], bodyParams: ["channel", "timestamp", "name"] },
  ],
};

export const jiraRecipe: PlatformRecipe = {
  id: "jira",
  name: "Jira",
  // Jira cloud requires the site cloud id in the path. Bearer OAuth token by
  // default; Atlassian API tokens authenticate as Basic with email:token —
  // store "email:api-token" and the SDK builds the Basic header per docs.
  baseUrl: "https://api.atlassian.com",
  auth: ({ token: t }) => {
    if (t.includes("|")) {
      const [, email, apiToken] = t.split("|");
      if (email && apiToken) return { authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}` };
    }
    return { authorization: `Bearer ${t}` };
  },
  actions: [
    { id: "search_jql", description: "Search issues with JQL.", method: "POST", path: "https://api.atlassian.com/ex/jira/{cloudid}/rest/api/3/search/jql", params: [{ name: "cloudid", type: "string", description: "Jira cloud id", required: true }, { name: "jql", type: "string", description: "JQL query, e.g. 'assignee = currentUser() ORDER BY updated DESC'", required: true }, { name: "maxResults", type: "number", description: "Max results (max 100)" }], bodyParams: ["jql", "maxResults"] },
    { id: "get_issue", description: "Read one issue by key.", method: "GET", path: "https://api.atlassian.com/ex/jira/{cloudid}/rest/api/3/issue/{issueKey}", params: [{ name: "cloudid", type: "string", description: "Jira cloud id", required: true }, { name: "issueKey", type: "string", description: "Issue key, e.g. PROJ-12", required: true }] },
    { id: "create_issue", description: "Create an issue in a project.", method: "POST", path: "https://api.atlassian.com/ex/jira/{cloudid}/rest/api/3/issue", params: [{ name: "cloudid", type: "string", description: "Jira cloud id", required: true }, { name: "fields", type: "string", description: "JSON object of issue fields", required: true }], bodyParams: ["fields"] },
    { id: "add_issue_comment", description: "Comment on an issue.", method: "POST", path: "https://api.atlassian.com/ex/jira/{cloudid}/rest/api/3/issue/{issueKey}/comment", params: [{ name: "cloudid", type: "string", description: "Jira cloud id", required: true }, { name: "issueKey", type: "string", description: "Issue key", required: true }, { name: "body", type: "string", description: "Comment body as JSON, e.g. {\"type\":\"doc\",...}", required: true }], bodyParams: ["body"] },
    { id: "transition_issue", description: "Move an issue to a new status.", method: "POST", path: "https://api.atlassian.com/ex/jira/{cloudid}/rest/api/3/issue/{issueKey}/transitions", params: [{ name: "cloudid", type: "string", description: "Jira cloud id", required: true }, { name: "issueKey", type: "string", description: "Issue key", required: true }, { name: "transition", type: "string", description: "Transition id as JSON, e.g. {\"id\":\"31\"}", required: true }], bodyParams: ["transition"] },
    { id: "list_projects", description: "List projects in the site.", method: "GET", path: "https://api.atlassian.com/ex/jira/{cloudid}/rest/api/3/project/search", params: [{ name: "cloudid", type: "string", description: "Jira cloud id", required: true }] },
    { id: "get_project", description: "Read one project's metadata.", method: "GET", path: "https://api.atlassian.com/ex/jira/{cloudid}/rest/api/3/project/{projectIdOrKey}", params: [{ name: "cloudid", type: "string", description: "Jira cloud id", required: true }, { name: "projectIdOrKey", type: "string", description: "Project id or key", required: true }] },
  ],
};

export const notionRecipe: PlatformRecipe = {
  id: "notion",
  name: "Notion",
  baseUrl: "https://api.notion.com/v1",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}`, "Notion-Version": "2026-03-11" }),
  actions: [
    { id: "search", description: "Search pages and databases in the workspace.", method: "POST", path: "https://api.notion.com/v1/search", params: [{ name: "query", type: "string", description: "Search text" }, { name: "filter", type: "string", description: "JSON filter, e.g. {\"property\":\"object\",\"value\":\"page\"}" }], bodyParams: ["query", "filter"] },
    { id: "get_page", description: "Read a page's properties.", method: "GET", path: "https://api.notion.com/v1/pages/{page_id}", params: [{ name: "page_id", type: "string", description: "Page UUID", required: true }] },
    { id: "get_blocks", description: "Read a page's content blocks.", method: "GET", path: "https://api.notion.com/v1/blocks/{block_id}/children", params: [{ name: "block_id", type: "string", description: "Block or page UUID", required: true }] },
    { id: "create_page", description: "Create a page in a parent database or page.", method: "POST", path: "https://api.notion.com/v1/pages", params: [{ name: "parent", type: "string", description: "JSON parent, e.g. {\"database_id\":\"...\"}", required: true }, { name: "properties", type: "string", description: "JSON properties object", required: true }], bodyParams: ["parent", "properties"] },
    { id: "update_page", description: "Update a page's properties or archive it.", method: "PATCH", path: "https://api.notion.com/v1/pages/{page_id}", params: [{ name: "page_id", type: "string", description: "Page UUID", required: true }, { name: "properties", type: "string", description: "JSON properties to set", required: true }], bodyParams: ["properties"] },
    { id: "query_database", description: "Filter and sort rows of a database.", method: "POST", path: "https://api.notion.com/v1/databases/{database_id}/query", params: [{ name: "database_id", type: "string", description: "Database UUID", required: true }, { name: "query", type: "string", description: "JSON query body, e.g. {\"filter\":{...}}", required: true }], bodyParams: ["query"] },
    { id: "get_database", description: "Read a database's schema.", method: "GET", path: "https://api.notion.com/v1/databases/{database_id}", params: [{ name: "database_id", type: "string", description: "Database UUID", required: true }] },
    { id: "append_blocks", description: "Append paragraph blocks to a page.", method: "PATCH", path: "https://api.notion.com/v1/blocks/{block_id}/children", params: [{ name: "block_id", type: "string", description: "Page or block UUID", required: true }, { name: "children", type: "string", description: "JSON array of block objects", required: true }], bodyParams: ["children"] },
    { id: "list_users", description: "List workspace members and bots.", method: "GET", path: "https://api.notion.com/v1/users", params: [] },
  ],
};

export const hubspotRecipe: PlatformRecipe = {
  id: "hubspot",
  name: "HubSpot",
  baseUrl: "https://api.hubapi.com",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "search_companies", description: "Search companies by keyword.", method: "POST", path: "https://api.hubapi.com/crm/v3/objects/companies/search", params: [{ name: "query", type: "string", description: "Search text", required: true }], bodyParams: ["query"] },
    { id: "search_contacts", description: "Search contacts by keyword.", method: "POST", path: "https://api.hubapi.com/crm/v3/objects/contacts/search", params: [{ name: "query", type: "string", description: "Search text", required: true }], bodyParams: ["query"] },
    { id: "create_contact", description: "Create a contact.", method: "POST", path: "https://api.hubapi.com/crm/v3/objects/contacts", params: [{ name: "email", type: "string", description: "Contact email", required: true }, { name: "firstname", type: "string", description: "First name" }, { name: "lastname", type: "string", description: "Last name" }], bodyParams: ["email", "firstname", "lastname"] },
    { id: "get_ticket", description: "Read a support ticket by id.", method: "GET", path: "https://api.hubapi.com/crm/v3/objects/tickets/{ticketId}", params: [{ name: "ticketId", type: "string", description: "Ticket id", required: true }] },
    { id: "get_contact", description: "Read a contact by id.", method: "GET", path: "https://api.hubapi.com/crm/v3/objects/contacts/{contactId}", params: [{ name: "contactId", type: "string", description: "Contact id", required: true }] },
    { id: "update_contact", description: "Update a contact's properties.", method: "PATCH", path: "https://api.hubapi.com/crm/v3/objects/contacts/{contactId}", params: [{ name: "contactId", type: "string", description: "Contact id", required: true }, { name: "properties", type: "string", description: "JSON of properties to set", required: true }], bodyParams: ["properties"] },
    { id: "search_deals", description: "Search deals by keyword.", method: "POST", path: "https://api.hubapi.com/crm/v3/objects/deals/search", params: [{ name: "query", type: "string", description: "Search text", required: true }], bodyParams: ["query"] },
    { id: "create_deal", description: "Create a deal in the pipeline.", method: "POST", path: "https://api.hubapi.com/crm/v3/objects/deals", params: [{ name: "dealname", type: "string", description: "Deal name", required: true }, { name: "amount", type: "number", description: "Deal amount" }, { name: "pipeline", type: "string", description: "Pipeline id" }], bodyParams: ["dealname", "amount", "pipeline"] },
    { id: "get_deal", description: "Read a deal by id.", method: "GET", path: "https://api.hubapi.com/crm/v3/objects/deals/{dealId}", params: [{ name: "dealId", type: "string", description: "Deal id", required: true }] },
  ],
};

export const salesforceRecipe: PlatformRecipe = {
  id: "salesforce",
  name: "Salesforce",
  // The stored credential is the instance URL + access token as "url|token".
  // REST calls go to the org instance (e.g. https://myorg.my.salesforce.com),
  // never to login.salesforce.com — see Salesforce REST API basics.
  baseUrl: (cred) => cred.token.split("|")[0] || "https://login.salesforce.com",
  auth: ({ token }) => ({ authorization: `Bearer ${token.split("|")[1] ?? token}` }),
  actions: [
    { id: "query", description: "Run a SOQL query against the org.", method: "GET", path: "services/data/v60.0/query", params: [{ name: "q", type: "string", description: "SOQL query, e.g. SELECT Id, Name FROM Account LIMIT 10", required: true }] },
    { id: "search", description: "Run a SOSL text search across objects.", method: "GET", path: "services/data/v60.0/search", params: [{ name: "q", type: "string", description: "SOSL query, e.g. FIND {Acme}", required: true }] },
    { id: "create_record", description: "Create a record of a given object type.", method: "POST", path: "services/data/v60.0/sobjects/{sobject}", params: [{ name: "sobject", type: "string", description: "Object type, e.g. Account, Case", required: true }, { name: "fields", type: "string", description: "JSON of field values", required: true }], bodyParams: ["fields"] },
    { id: "get_record", description: "Read one record by id.", method: "GET", path: "services/data/v60.0/sobjects/{sobject}/{id}", params: [{ name: "sobject", type: "string", description: "Object type", required: true }, { name: "id", type: "string", description: "Record id", required: true }] },
    { id: "update_record", description: "Update one record by id.", method: "PATCH", path: "services/data/v60.0/sobjects/{sobject}/{id}", params: [{ name: "sobject", type: "string", description: "Object type", required: true }, { name: "id", type: "string", description: "Record id", required: true }, { name: "fields", type: "string", description: "JSON of field values", required: true }], bodyParams: ["fields"] },
    { id: "delete_record", description: "Delete one record by id.", method: "DELETE", path: "services/data/v60.0/sobjects/{sobject}/{id}", params: [{ name: "sobject", type: "string", description: "Object type", required: true }, { name: "id", type: "string", description: "Record id", required: true }] },
    { id: "describe_sobject", description: "List an object's fields and types.", method: "GET", path: "services/data/v60.0/sobjects/{sobject}/describe", params: [{ name: "sobject", type: "string", description: "Object type", required: true }] },
  ],
};

export const sharepointRecipe: PlatformRecipe = {
  id: "sharepoint",
  name: "Microsoft SharePoint / OneDrive",
  baseUrl: "https://graph.microsoft.com/v1.0",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "search_drive", description: "Search files across OneDrive and SharePoint.", method: "GET", path: "https://graph.microsoft.com/v1.0/me/drive/root/search(q='{q}')", params: [{ name: "q", type: "string", description: "Search text", required: true }] },
    { id: "list_recent", description: "List recently used drive items.", method: "GET", path: "https://graph.microsoft.com/v1.0/me/drive/recent", params: [] },
    { id: "download_file", description: "Get a file's metadata and download URL.", method: "GET", path: "https://graph.microsoft.com/v1.0/me/drive/items/{item_id}", params: [{ name: "item_id", type: "string", description: "Drive item id", required: true }] },
    { id: "list_children", description: "List a folder's contents.", method: "GET", path: "https://graph.microsoft.com/v1.0/me/drive/items/{item_id}/children", params: [{ name: "item_id", type: "string", description: "Folder item id", required: true }] },
    { id: "list_sites", description: "Find SharePoint sites by keyword.", method: "GET", path: "https://graph.microsoft.com/v1.0/sites", params: [{ name: "search", type: "string", description: "Site name query", required: true }] },
    { id: "create_folder", description: "Create a folder in the drive root or a parent folder.", method: "POST", path: "https://graph.microsoft.com/v1.0/me/drive/items/{item_id}/children", params: [{ name: "item_id", type: "string", description: "Parent folder id", required: true }, { name: "name", type: "string", description: "Folder name", required: true }], bodyParams: ["name"] },
  ],
};

export const googleDriveRecipe: PlatformRecipe = {
  id: "google-drive",
  name: "Google Drive",
  baseUrl: "https://www.googleapis.com",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "search_files", description: "Search Drive files by name or content.", method: "GET", path: "https://www.googleapis.com/drive/v3/files", params: [{ name: "q", type: "string", description: "Drive query, e.g. name contains 'report'", required: true }, { name: "pageSize", type: "number", description: "Max results (max 100)" }] },
    { id: "list_files", description: "List files in a folder.", method: "GET", path: "https://www.googleapis.com/drive/v3/files", params: [{ name: "q", type: "string", description: "Query, e.g. 'folderId' in parents", required: true }] },
    { id: "get_file", description: "Read a file's metadata.", method: "GET", path: "https://www.googleapis.com/drive/v3/files/{fileId}", params: [{ name: "fileId", type: "string", description: "Drive file id", required: true }] },
    { id: "download_file", description: "Download a file's raw content (metadata + media).", method: "GET", path: "https://www.googleapis.com/drive/v3/files/{fileId}?alt=media", params: [{ name: "fileId", type: "string", description: "Drive file id", required: true }] },
    { id: "export_pdf", description: "Export a Google Doc as PDF bytes URL.", method: "GET", path: "https://www.googleapis.com/drive/v3/files/{fileId}/export", params: [{ name: "fileId", type: "string", description: "Drive file id", required: true }, { name: "mimeType", type: "string", description: "Target mime type, e.g. application/pdf", required: true }] },
    { id: "create_folder", description: "Create a folder.", method: "POST", path: "https://www.googleapis.com/drive/v3/files", params: [{ name: "name", type: "string", description: "Folder name", required: true }, { name: "parent", type: "string", description: "Parent folder id" }], bodyParams: ["name", "parent"] },
  ],
};

export const gmailRecipe: PlatformRecipe = {
  id: "gmail",
  name: "Gmail",
  baseUrl: "https://gmail.googleapis.com",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "list_messages", description: "List messages in the mailbox.", method: "GET", path: "https://gmail.googleapis.com/gmail/v1/users/me/messages", params: [{ name: "maxResults", type: "number", description: "Max results (max 500)" }] },
    { id: "search_messages", description: "Search messages with Gmail query syntax.", method: "GET", path: "https://gmail.googleapis.com/gmail/v1/users/me/messages", params: [{ name: "q", type: "string", description: "Gmail query, e.g. from:boss@acme.com is:unread", required: true }, { name: "maxResults", type: "number", description: "Max results" }] },
    { id: "get_message", description: "Read one message by id.", method: "GET", path: "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}", params: [{ name: "id", type: "string", description: "Message id", required: true }] },
    { id: "send_message", description: "Send an email (raw base64url RFC 2822 message).", method: "POST", path: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", params: [{ name: "raw", type: "string", description: "base64url-encoded RFC 2822 message", required: true }], bodyParams: ["raw"] },
    { id: "create_draft", description: "Create a draft email.", method: "POST", path: "https://gmail.googleapis.com/gmail/v1/users/me/drafts", params: [{ name: "raw", type: "string", description: "base64url-encoded RFC 2822 message", required: true }], bodyParams: ["raw"] },
    { id: "trash_message", description: "Move a message to trash.", method: "POST", path: "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}/trash", params: [{ name: "id", type: "string", description: "Message id", required: true }] },
    { id: "list_labels", description: "List the mailbox's labels.", method: "GET", path: "https://gmail.googleapis.com/gmail/v1/users/me/labels", params: [] },
  ],
};

export const googleCalendarRecipe: PlatformRecipe = {
  id: "google-calendar",
  name: "Google Calendar",
  baseUrl: "https://www.googleapis.com",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "list_calendars", description: "List the user's calendars.", method: "GET", path: "https://www.googleapis.com/calendar/v3/users/me/calendarList", params: [] },
    { id: "list_events", description: "List events on a calendar in a time range.", method: "GET", path: "https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events", params: [{ name: "calendarId", type: "string", description: "Calendar id, usually 'primary'", required: true }, { name: "timeMin", type: "string", description: "Start of range (ISO)" }, { name: "timeMax", type: "string", description: "End of range (ISO)" }, { name: "maxResults", type: "number", description: "Max results" }] },
    { id: "get_event", description: "Read one event.", method: "GET", path: "https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}", params: [{ name: "calendarId", type: "string", description: "Calendar id", required: true }, { name: "eventId", type: "string", description: "Event id", required: true }] },
    { id: "create_event", description: "Create an event.", method: "POST", path: "https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events", params: [{ name: "calendarId", type: "string", description: "Calendar id, usually 'primary'", required: true }, { name: "event", type: "string", description: "JSON event body, e.g. {\"summary\":\"...\",\"start\":{...},\"end\":{...}}", required: true }], bodyParams: ["event"] },
    { id: "update_event", description: "Update an event.", method: "PATCH", path: "https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}", params: [{ name: "calendarId", type: "string", description: "Calendar id", required: true }, { name: "eventId", type: "string", description: "Event id", required: true }, { name: "event", type: "string", description: "JSON fields to set", required: true }], bodyParams: ["event"] },
    { id: "delete_event", description: "Delete an event.", method: "DELETE", path: "https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}", params: [{ name: "calendarId", type: "string", description: "Calendar id", required: true }, { name: "eventId", type: "string", description: "Event id", required: true }] },
  ],
};

export const googleSheetsRecipe: PlatformRecipe = {
  id: "google-sheets",
  name: "Google Sheets",
  baseUrl: "https://sheets.googleapis.com",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "get_spreadsheet", description: "Read a spreadsheet's sheets and metadata.", method: "GET", path: "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}", params: [{ name: "spreadsheetId", type: "string", description: "Spreadsheet id", required: true }] },
    { id: "get_values", description: "Read a range of cells.", method: "GET", path: "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}", params: [{ name: "spreadsheetId", type: "string", description: "Spreadsheet id", required: true }, { name: "range", type: "string", description: "A1 notation, e.g. Sheet1!A1:D10", required: true }] },
    { id: "append_row", description: "Append rows to a sheet.", method: "POST", path: "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}:append?valueInputOption=USER_ENTERED", params: [{ name: "spreadsheetId", type: "string", description: "Spreadsheet id", required: true }, { name: "range", type: "string", description: "A1 notation of the sheet or range", required: true }, { name: "values", type: "string", description: "JSON {\"values\":[[...],[...]]}", required: true }], bodyParams: ["values"] },
    { id: "update_row", description: "Overwrite a range of cells.", method: "PUT", path: "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}?valueInputOption=USER_ENTERED", params: [{ name: "spreadsheetId", type: "string", description: "Spreadsheet id", required: true }, { name: "range", type: "string", description: "A1 notation", required: true }, { name: "values", type: "string", description: "JSON {\"values\":[[...]]}", required: true }], bodyParams: ["values"] },
    { id: "create_spreadsheet", description: "Create a new spreadsheet.", method: "POST", path: "https://sheets.googleapis.com/v4/spreadsheets", params: [{ name: "properties", type: "string", description: "JSON {\"title\":\"...\"}", required: true }], bodyParams: ["properties"] },
  ],
};

export const googleDocsRecipe: PlatformRecipe = {
  id: "google-docs",
  name: "Google Docs",
  baseUrl: "https://docs.googleapis.com",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "get_document", description: "Read a document's structure and text.", method: "GET", path: "https://docs.googleapis.com/v1/documents/{documentId}", params: [{ name: "documentId", type: "string", description: "Document id", required: true }] },
    { id: "create_document", description: "Create an empty document.", method: "POST", path: "https://docs.googleapis.com/v1/documents", params: [{ name: "title", type: "string", description: "Document title", required: true }], bodyParams: ["title"] },
    { id: "insert_text", description: "Insert text via batchUpdate.", method: "POST", path: "https://docs.googleapis.com/v1/documents/{documentId}:batchUpdate", params: [{ name: "documentId", type: "string", description: "Document id", required: true }, { name: "requests", type: "string", description: "JSON requests array, e.g. [{\"insertText\":{...}}]", required: true }], bodyParams: ["requests"] },
  ],
};

export const googleTasksRecipe: PlatformRecipe = {
  id: "google-tasks",
  name: "Google Tasks",
  baseUrl: "https://tasks.googleapis.com",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "list_tasklists", description: "List the user's task lists.", method: "GET", path: "https://tasks.googleapis.com/tasks/v1/users/@me/lists", params: [] },
    { id: "list_tasks", description: "List tasks in a list.", method: "GET", path: "https://tasks.googleapis.com/tasks/v1/lists/{tasklist}/tasks", params: [{ name: "tasklist", type: "string", description: "Task list id", required: true }, { name: "showCompleted", type: "boolean", description: "Include completed tasks" }] },
    { id: "create_task", description: "Add a task to a list.", method: "POST", path: "https://tasks.googleapis.com/tasks/v1/lists/{tasklist}/tasks", params: [{ name: "tasklist", type: "string", description: "Task list id", required: true }, { name: "title", type: "string", description: "Task title", required: true }, { name: "notes", type: "string", description: "Task notes" }], bodyParams: ["title", "notes"] },
    { id: "complete_task", description: "Mark a task completed.", method: "PATCH", path: "https://tasks.googleapis.com/tasks/v1/lists/{tasklist}/tasks/{task}", params: [{ name: "tasklist", type: "string", description: "Task list id", required: true }, { name: "task", type: "string", description: "Task id", required: true }, { name: "status", type: "string", description: "Set to 'completed'", required: true }], bodyParams: ["status"] },
  ],
};

export const teamsRecipe: PlatformRecipe = {
  id: "microsoft-teams",
  name: "Microsoft Teams",
  baseUrl: "https://graph.microsoft.com/v1.0",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "list_teams", description: "List the teams the user has joined.", method: "GET", path: "https://graph.microsoft.com/v1.0/me/joinedTeams", params: [] },
    { id: "list_channels", description: "List a team's channels.", method: "GET", path: "https://graph.microsoft.com/v1.0/teams/{teamId}/channels", params: [{ name: "teamId", type: "string", description: "Team id", required: true }] },
    { id: "send_channel_message", description: "Post a message to a channel.", method: "POST", path: "https://graph.microsoft.com/v1.0/teams/{teamId}/channels/{channelId}/messages", params: [{ name: "teamId", type: "string", description: "Team id", required: true }, { name: "channelId", type: "string", description: "Channel id", required: true }, { name: "content", type: "string", description: "Message text", required: true }], bodyParams: ["content"] },
    { id: "list_messages", description: "Read recent messages in a channel.", method: "GET", path: "https://graph.microsoft.com/v1.0/teams/{teamId}/channels/{channelId}/messages", params: [{ name: "teamId", type: "string", description: "Team id", required: true }, { name: "channelId", type: "string", description: "Channel id", required: true }] },
  ],
};

export const outlookMailRecipe: PlatformRecipe = {
  id: "outlook-mail",
  name: "Outlook Mail",
  baseUrl: "https://graph.microsoft.com/v1.0",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "list_messages", description: "List the inbox's recent messages.", method: "GET", path: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages", params: [{ name: "top", type: "number", description: "Max results" }] },
    { id: "search_messages", description: "Search mail with KQL.", method: "GET", path: "https://graph.microsoft.com/v1.0/me/messages", params: [{ name: "$search", type: "string", description: "KQL query, e.g. \"from:ceo@acme.com\"", required: true }] },
    { id: "get_message", description: "Read one message by id.", method: "GET", path: "https://graph.microsoft.com/v1.0/me/messages/{messageId}", params: [{ name: "messageId", type: "string", description: "Message id", required: true }] },
    { id: "send_mail", description: "Send an email.", method: "POST", path: "https://graph.microsoft.com/v1.0/me/sendMail", params: [{ name: "message", type: "string", description: "JSON message body {\"subject\":\"...\",\"toRecipients\":[...],\"body\":{...}}", required: true }], bodyParams: ["message"] },
    { id: "mark_read", description: "Mark a message read or unread.", method: "PATCH", path: "https://graph.microsoft.com/v1.0/me/messages/{messageId}", params: [{ name: "messageId", type: "string", description: "Message id", required: true }, { name: "isRead", type: "boolean", description: "Read state", required: true }], bodyParams: ["isRead"] },
  ],
};

export const outlookCalendarRecipe: PlatformRecipe = {
  id: "outlook-calendar",
  name: "Outlook Calendar",
  baseUrl: "https://graph.microsoft.com/v1.0",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "list_events", description: "List events in the default calendar.", method: "GET", path: "https://graph.microsoft.com/v1.0/me/calendarview", params: [{ name: "startDateTime", type: "string", description: "Range start (ISO)", required: true }, { name: "endDateTime", type: "string", description: "Range end (ISO)", required: true }] },
    { id: "get_event", description: "Read one event.", method: "GET", path: "https://graph.microsoft.com/v1.0/me/events/{eventId}", params: [{ name: "eventId", type: "string", description: "Event id", required: true }] },
    { id: "create_event", description: "Create an event.", method: "POST", path: "https://graph.microsoft.com/v1.0/me/events", params: [{ name: "event", type: "string", description: "JSON event body {\"subject\":\"...\",\"start\":{...},\"end\":{...}}", required: true }], bodyParams: ["event"] },
    { id: "update_event", description: "Update an event.", method: "PATCH", path: "https://graph.microsoft.com/v1.0/me/events/{eventId}", params: [{ name: "eventId", type: "string", description: "Event id", required: true }, { name: "event", type: "string", description: "JSON fields to set", required: true }], bodyParams: ["event"] },
  ],
};

export const excelOnlineRecipe: PlatformRecipe = {
  id: "excel-online",
  name: "Microsoft Excel Online",
  baseUrl: "https://graph.microsoft.com/v1.0",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "list_worksheets", description: "List the worksheets in a workbook.", method: "GET", path: "https://graph.microsoft.com/v1.0/me/drive/items/{item_id}/workbook/worksheets", params: [{ name: "item_id", type: "string", description: "Drive item id of the workbook", required: true }] },
    { id: "get_range", description: "Read a cell range from a worksheet.", method: "GET", path: "https://graph.microsoft.com/v1.0/me/drive/items/{item_id}/workbook/worksheets/{worksheet}/range(address='{address}')", params: [{ name: "item_id", type: "string", description: "Drive item id", required: true }, { name: "worksheet", type: "string", description: "Worksheet id or name", required: true }, { name: "address", type: "string", description: "Range in A1 notation, e.g. A1:D4", required: true }] },
    { id: "add_row", description: "Append a row to a table.", method: "POST", path: "https://graph.microsoft.com/v1.0/me/drive/items/{item_id}/workbook/tables/{table}/rows/add", params: [{ name: "item_id", type: "string", description: "Drive item id", required: true }, { name: "table", type: "string", description: "Table id or name", required: true }, { name: "values", type: "string", description: "JSON {\"values\":[[...]]}", required: true }], bodyParams: ["values"] },
    { id: "list_tables", description: "List the workbook's tables.", method: "GET", path: "https://graph.microsoft.com/v1.0/me/drive/items/{item_id}/workbook/tables", params: [{ name: "item_id", type: "string", description: "Drive item id", required: true }] },
  ],
};

export const zendeskRecipe: PlatformRecipe = {
  id: "zendesk",
  name: "Zendesk",
  // Credential: Account = subdomain ("acme"), token = "email:api-token".
  // Auth is Basic with username "email/token" and the API token as password,
  // and every call goes to https://{subdomain}.zendesk.com/api/v2.
  baseUrl: (cred) => `https://${cred.account ?? "SUBDOMAIN"}.zendesk.com/api/v2`,
  auth: ({ token: t }) => {
    const [email, apiToken] = t.split(":");
    return { authorization: `Basic ${Buffer.from(`${email ?? t}/token:${apiToken ?? t}`).toString("base64")}` };
  },
  actions: [
    { id: "list_tickets", description: "List tickets in the account.", method: "GET", path: "tickets", params: [{ name: "per_page", type: "number", description: "Results per page (max 100)" }] },
    { id: "search_tickets", description: "Search tickets with Zendesk query syntax.", method: "GET", path: "search", params: [{ name: "query", type: "string", description: "Query, e.g. type:ticket status:open", required: true }] },
    { id: "get_ticket", description: "Read one ticket.", method: "GET", path: "tickets/{ticket_id}", params: [{ name: "ticket_id", type: "string", description: "Ticket id", required: true }] },
    { id: "create_ticket", description: "Create a ticket.", method: "POST", path: "tickets", params: [{ name: "ticket", type: "string", description: "JSON {\"ticket\":{\"subject\":...,\"comment\":{...}}}", required: true }], bodyParams: ["ticket"] },
    { id: "update_ticket", description: "Update a ticket's status or fields.", method: "PUT", path: "tickets/{ticket_id}", params: [{ name: "ticket_id", type: "string", description: "Ticket id", required: true }, { name: "ticket", type: "string", description: "JSON fields to set", required: true }], bodyParams: ["ticket"] },
    { id: "list_ticket_comments", description: "Read a ticket's comment thread.", method: "GET", path: "tickets/{ticket_id}/comments", params: [{ name: "ticket_id", type: "string", description: "Ticket id", required: true }] },
  ],
};

export const freshdeskRecipe: PlatformRecipe = {
  id: "freshdesk",
  name: "Freshdesk",
  // Credential: Account = domain prefix ("acme"), token = API key.
  // Auth is Basic with the API key as username and "X" as password; every call
  // goes to https://{domain}.freshdesk.com/api/v2.
  baseUrl: (cred) => `https://${cred.account ?? "DOMAIN"}.freshdesk.com/api/v2`,
  auth: ({ token: t }) => ({ authorization: `Basic ${Buffer.from(`${t}:X`).toString("base64")}` }),
  actions: [
    { id: "list_tickets", description: "List tickets with optional filter.", method: "GET", path: "tickets", params: [{ name: "filter", type: "string", description: "Predefined filter, e.g. new_and_my_open" }] },
    { id: "get_ticket", description: "Read one ticket.", method: "GET", path: "tickets/{id}", params: [{ name: "id", type: "string", description: "Ticket id", required: true }] },
    { id: "create_ticket", description: "Create a ticket.", method: "POST", path: "tickets", params: [{ name: "subject", type: "string", description: "Ticket subject", required: true }, { name: "description", type: "string", description: "Ticket description", required: true }, { name: "email", type: "string", description: "Requester email", required: true }], bodyParams: ["subject", "description", "email"] },
    { id: "update_ticket", description: "Update a ticket.", method: "PUT", path: "tickets/{id}", params: [{ name: "id", type: "string", description: "Ticket id", required: true }, { name: "status", type: "number", description: "Status code, e.g. 3 pending, 4 resolved" }], bodyParams: ["status"] },
    { id: "list_contacts", description: "List customer contacts.", method: "GET", path: "contacts", params: [] },
  ],
};

export const intercomRecipe: PlatformRecipe = {
  id: "intercom",
  name: "Intercom",
  baseUrl: "https://api.intercom.io",
  // REST API requires Intercom-Version; 2.18 is the current stable version.
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}`, "intercom-version": "2.18" }),
  actions: [
    { id: "list_conversations", description: "List recent conversations.", method: "GET", path: "https://api.intercom.io/conversations", params: [{ name: "per_page", type: "number", description: "Results per page (max 150)" }] },
    { id: "get_conversation", description: "Read one conversation with its thread.", method: "GET", path: "https://api.intercom.io/conversations/{id}", params: [{ name: "id", type: "string", description: "Conversation id", required: true }] },
    { id: "reply_conversation", description: "Reply to a conversation as an admin.", method: "POST", path: "https://api.intercom.io/conversations/{id}/reply", params: [{ name: "id", type: "string", description: "Conversation id", required: true }, { name: "message", type: "string", description: "Reply text", required: true }], bodyParams: ["message"] },
    { id: "list_contacts", description: "List people in the workspace.", method: "GET", path: "https://api.intercom.io/contacts", params: [{ name: "per_page", type: "number", description: "Results per page (max 150)" }] },
    { id: "get_contact", description: "Read one contact by id.", method: "GET", path: "https://api.intercom.io/contacts/{id}", params: [{ name: "id", type: "string", description: "Contact id", required: true }] },
  ],
};

export const serviceNowRecipe: PlatformRecipe = {
  id: "servicenow",
  name: "ServiceNow",
  // Credential: Account = instance name ("dev12345"), token = "user:password".
  // Basic auth against the instance URL per the Table API docs.
  baseUrl: (cred) => `https://${cred.account ?? "INSTANCE"}.service-now.com`,
  auth: ({ token: t }) => ({ authorization: `Basic ${Buffer.from(t).toString("base64")}` }),
  actions: [
    { id: "list_incidents", description: "List incident records.", method: "GET", path: "api/now/table/incident", params: [{ name: "sysparm_limit", type: "number", description: "Max records (max 100)" }, { name: "sysparm_query", type: "string", description: "Encoded query, e.g. priority=1" }] },
    { id: "get_incident", description: "Read one incident by sys_id.", method: "GET", path: "api/now/table/incident/{sys_id}", params: [{ name: "sys_id", type: "string", description: "Record sys_id", required: true }] },
    { id: "create_incident", description: "Open a new incident.", method: "POST", path: "api/now/table/incident", params: [{ name: "short_description", type: "string", description: "Incident summary", required: true }, { name: "urgency", type: "number", description: "1 high, 2 medium, 3 low" }], bodyParams: ["short_description", "urgency"] },
    { id: "update_incident", description: "Update an incident.", method: "PATCH", path: "api/now/table/incident/{sys_id}", params: [{ name: "sys_id", type: "string", description: "Record sys_id", required: true }, { name: "fields", type: "string", description: "JSON fields to set", required: true }], bodyParams: ["fields"] },
    { id: "list_table_records", description: "List records of any table.", method: "GET", path: "api/now/table/{table}", params: [{ name: "table", type: "string", description: "Table name, e.g. change_request", required: true }, { name: "sysparm_limit", type: "number", description: "Max records" }] },
  ],
};

export const stripeRecipe: PlatformRecipe = {
  id: "stripe",
  name: "Stripe",
  baseUrl: "https://api.stripe.com/v1",
  // Stripe POST bodies are application/x-www-form-urlencoded, not JSON.
  encoding: "form",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "get_balance", description: "Read the account's current balance.", method: "GET", path: "https://api.stripe.com/v1/balance", params: [] },
    { id: "list_customers", description: "List customers.", method: "GET", path: "https://api.stripe.com/v1/customers", params: [{ name: "email", type: "string", description: "Filter by email" }, { name: "limit", type: "number", description: "Results (max 100)" }] },
    { id: "get_customer", description: "Read one customer.", method: "GET", path: "https://api.stripe.com/v1/customers/{id}", params: [{ name: "id", type: "string", description: "Customer id", required: true }] },
    { id: "list_invoices", description: "List invoices, newest first.", method: "GET", path: "https://api.stripe.com/v1/invoices", params: [{ name: "customer", type: "string", description: "Filter by customer id" }, { name: "status", type: "string", description: "draft, open, paid or void" }, { name: "limit", type: "number", description: "Results (max 100)" }] },
    { id: "get_invoice", description: "Read one invoice.", method: "GET", path: "https://api.stripe.com/v1/invoices/{id}", params: [{ name: "id", type: "string", description: "Invoice id", required: true }] },
    { id: "list_products", description: "List products in the catalog.", method: "GET", path: "https://api.stripe.com/v1/products", params: [{ name: "limit", type: "number", description: "Results (max 100)" }] },
    { id: "create_payment_link", description: "Create a hosted payment link for a price.", method: "POST", path: "https://api.stripe.com/v1/payment_links", params: [{ name: "price", type: "string", description: "Price id", required: true }, { name: "quantity", type: "number", description: "Fixed quantity" }], bodyParams: ["price", "quantity"] },
  ],
};

export const shopifyRecipe: PlatformRecipe = {
  id: "shopify",
  name: "Shopify",
  // Credential: Account = shop handle ("acme"), token = Admin API access
  // token, sent as X-Shopify-Access-Token against the versioned Admin URL.
  baseUrl: (cred) => `https://${cred.account ?? "SHOP"}.myshopify.com/admin/api/2026-10`,
  auth: ({ token: t }) => ({ "X-Shopify-Access-Token": t }),
  actions: [
    { id: "list_orders", description: "List orders in the store.", method: "GET", path: "orders.json", params: [{ name: "status", type: "string", description: "open, closed, cancelled or any" }, { name: "limit", type: "number", description: "Results (max 250)" }] },
    { id: "get_order", description: "Read one order.", method: "GET", path: "orders/{order_id}.json", params: [{ name: "order_id", type: "string", description: "Order id", required: true }] },
    { id: "list_products", description: "List products in the catalog.", method: "GET", path: "products.json", params: [{ name: "limit", type: "number", description: "Results (max 250)" }] },
    { id: "get_product", description: "Read one product with variants.", method: "GET", path: "products/{product_id}.json", params: [{ name: "product_id", type: "string", description: "Product id", required: true }] },
    { id: "create_product", description: "Create a product.", method: "POST", path: "products.json", params: [{ name: "product", type: "string", description: "JSON {\"product\":{\"title\":...}}", required: true }], bodyParams: ["product"] },
    { id: "list_customers", description: "List store customers.", method: "GET", path: "customers.json", params: [{ name: "limit", type: "number", description: "Results (max 250)" }] },
  ],
};

export const mailchimpRecipe: PlatformRecipe = {
  id: "mailchimp",
  name: "Mailchimp",
  // Credential: Account = datacenter ("us19"); falls back to the key's own
  // "-usXX" suffix when unset. Auth is Basic with any username and the key.
  baseUrl: (cred) => {
    const dc = cred.account ?? cred.token.split("-").pop() ?? "us1";
    return `https://${dc}.api.mailchimp.com`;
  },
  auth: ({ token: t }) => ({ authorization: `Basic ${Buffer.from(`quillon:${t}`).toString("base64")}` }),
  actions: [
    { id: "list_audiences", description: "List audiences (lists).", method: "GET", path: "3.0/lists", params: [{ name: "count", type: "number", description: "Results (max 1000)" }] },
    { id: "list_members", description: "List members of an audience.", method: "GET", path: "3.0/lists/{list_id}/members", params: [{ name: "list_id", type: "string", description: "Audience id", required: true }, { name: "count", type: "number", description: "Results" }] },
    { id: "add_member", description: "Subscribe a member to an audience.", method: "POST", path: "3.0/lists/{list_id}/members", params: [{ name: "list_id", type: "string", description: "Audience id", required: true }, { name: "email_address", type: "string", description: "Email", required: true }, { name: "status", type: "string", description: "subscribed or pending", required: true }], bodyParams: ["email_address", "status"] },
    { id: "list_campaigns", description: "List email campaigns.", method: "GET", path: "3.0/campaigns", params: [{ name: "count", type: "number", description: "Results" }] },
    { id: "get_campaign", description: "Read one campaign's settings and content.", method: "GET", path: "3.0/campaigns/{campaign_id}", params: [{ name: "campaign_id", type: "string", description: "Campaign id", required: true }] },
  ],
};

export const twilioRecipe: PlatformRecipe = {
  id: "twilio",
  name: "Twilio",
  // Credential: token = "AccountSid:AuthToken" (or "ApiKeySid:ApiSecret"),
  // authenticated as HTTP Basic per Twilio's docs.
  baseUrl: "https://api.twilio.com",
  auth: ({ token: t }) => ({ authorization: `Basic ${Buffer.from(t).toString("base64")}` }),
  actions: [
    { id: "send_sms", description: "Send an SMS from a Twilio number.", method: "POST", path: "https://api.twilio.com/2010-04-01/Accounts/{accountSid}/Messages.json", params: [{ name: "accountSid", type: "string", description: "Account SID", required: true }, { name: "To", type: "string", description: "Destination number", required: true }, { name: "From", type: "string", description: "Twilio number", required: true }, { name: "Body", type: "string", description: "Message text", required: true }], bodyParams: ["To", "From", "Body"] },
    { id: "list_messages", description: "List recent messages.", method: "GET", path: "https://api.twilio.com/2010-04-01/Accounts/{accountSid}/Messages.json", params: [{ name: "accountSid", type: "string", description: "Account SID", required: true }, { name: "pageSize", type: "number", description: "Results per page" }] },
    { id: "get_message", description: "Read one message by SID.", method: "GET", path: "https://api.twilio.com/2010-04-01/Accounts/{accountSid}/Messages/{sid}.json", params: [{ name: "accountSid", type: "string", description: "Account SID", required: true }, { name: "sid", type: "string", description: "Message SID", required: true }] },
    { id: "list_calls", description: "List recent calls.", method: "GET", path: "https://api.twilio.com/2010-04-01/Accounts/{accountSid}/Calls.json", params: [{ name: "accountSid", type: "string", description: "Account SID", required: true }, { name: "pageSize", type: "number", description: "Results per page" }] },
  ],
};

export const zoomRecipe: PlatformRecipe = {
  id: "zoom",
  name: "Zoom",
  baseUrl: "https://api.zoom.us/v2",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "list_meetings", description: "List the user's upcoming meetings.", method: "GET", path: "https://api.zoom.us/v2/users/me/meetings", params: [{ name: "type", type: "string", description: "scheduled, live or upcoming" }, { name: "page_size", type: "number", description: "Results (max 300)" }] },
    { id: "get_meeting", description: "Read one meeting's details.", method: "GET", path: "https://api.zoom.us/v2/meetings/{meetingId}", params: [{ name: "meetingId", type: "string", description: "Meeting id", required: true }] },
    { id: "create_meeting", description: "Schedule a meeting.", method: "POST", path: "https://api.zoom.us/v2/users/me/meetings", params: [{ name: "topic", type: "string", description: "Meeting topic", required: true }, { name: "start_time", type: "string", description: "Start time (ISO)", required: true }, { name: "duration", type: "number", description: "Duration in minutes" }], bodyParams: ["topic", "start_time", "duration"] },
    { id: "list_recordings", description: "List a meeting's cloud recordings.", method: "GET", path: "https://api.zoom.us/v2/meetings/{meetingId}/recordings", params: [{ name: "meetingId", type: "string", description: "Meeting id", required: true }] },
  ],
};

export const asanaRecipe: PlatformRecipe = {
  id: "asana",
  name: "Asana",
  baseUrl: "https://app.asana.com/api/1.0",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "list_workspaces", description: "List the user's workspaces.", method: "GET", path: "https://app.asana.com/api/1.0/workspaces", params: [] },
    { id: "list_projects", description: "List projects in a workspace.", method: "GET", path: "https://app.asana.com/api/1.0/projects", params: [{ name: "workspace", type: "string", description: "Workspace gid", required: true }, { name: "limit", type: "number", description: "Results (max 100)" }] },
    { id: "list_tasks", description: "List tasks in a project.", method: "GET", path: "https://app.asana.com/api/1.0/tasks", params: [{ name: "project", type: "string", description: "Project gid", required: true }, { name: "completed_since", type: "string", description: "'now' to exclude completed" }] },
    { id: "get_task", description: "Read one task.", method: "GET", path: "https://app.asana.com/api/1.0/tasks/{task_gid}", params: [{ name: "task_gid", type: "string", description: "Task gid", required: true }] },
    { id: "create_task", description: "Create a task in a project.", method: "POST", path: "https://app.asana.com/api/1.0/tasks", params: [{ name: "name", type: "string", description: "Task name", required: true }, { name: "projects", type: "string", description: "Project gid", required: true }, { name: "notes", type: "string", description: "Task notes" }], bodyParams: ["name", "projects", "notes"] },
    { id: "update_task", description: "Update or complete a task.", method: "PUT", path: "https://app.asana.com/api/1.0/tasks/{task_gid}", params: [{ name: "task_gid", type: "string", description: "Task gid", required: true }, { name: "completed", type: "boolean", description: "Completion state" }, { name: "name", type: "string", description: "New name" }], bodyParams: ["completed", "name"] },
  ],
};

export const mondayRecipe: PlatformRecipe = {
  id: "monday",
  name: "Monday.com",
  baseUrl: "https://api.monday.com/v2",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "get_boards", description: "List boards via GraphQL.", method: "POST", path: "https://api.monday.com/v2", params: [{ name: "query", type: "string", description: "GraphQL query, e.g. { boards { id name } }", required: true }], bodyParams: ["query"] },
    { id: "get_items", description: "Read items of a board via GraphQL.", method: "POST", path: "https://api.monday.com/v2", params: [{ name: "query", type: "string", description: "GraphQL query with board ids", required: true }], bodyParams: ["query"] },
    { id: "create_item", description: "Create an item on a board via GraphQL.", method: "POST", path: "https://api.monday.com/v2", params: [{ name: "query", type: "string", description: "GraphQL mutation create_item(...)", required: true }], bodyParams: ["query"] },
  ],
};

export const airtableRecipe: PlatformRecipe = {
  id: "airtable",
  name: "Airtable",
  baseUrl: "https://api.airtable.com/v0",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "list_bases", description: "List the token's bases.", method: "GET", path: "https://api.airtable.com/v0/meta/bases", params: [] },
    { id: "list_records", description: "List records in a table.", method: "GET", path: "https://api.airtable.com/v0/{baseId}/{tableIdOrName}", params: [{ name: "baseId", type: "string", description: "Base id", required: true }, { name: "tableIdOrName", type: "string", description: "Table id or name", required: true }, { name: "maxRecords", type: "number", description: "Max records" }, { name: "filterByFormula", type: "string", description: "Airtable formula filter" }] },
    { id: "get_record", description: "Read one record.", method: "GET", path: "https://api.airtable.com/v0/{baseId}/{tableIdOrName}/{recordId}", params: [{ name: "baseId", type: "string", description: "Base id", required: true }, { name: "tableIdOrName", type: "string", description: "Table id or name", required: true }, { name: "recordId", type: "string", description: "Record id", required: true }] },
    { id: "create_record", description: "Create a record.", method: "POST", path: "https://api.airtable.com/v0/{baseId}/{tableIdOrName}", params: [{ name: "baseId", type: "string", description: "Base id", required: true }, { name: "tableIdOrName", type: "string", description: "Table id or name", required: true }, { name: "fields", type: "string", description: "JSON of field values", required: true }], bodyParams: ["fields"] },
    { id: "update_record", description: "Update a record.", method: "PATCH", path: "https://api.airtable.com/v0/{baseId}/{tableIdOrName}/{recordId}", params: [{ name: "baseId", type: "string", description: "Base id", required: true }, { name: "tableIdOrName", type: "string", description: "Table id or name", required: true }, { name: "recordId", type: "string", description: "Record id", required: true }, { name: "fields", type: "string", description: "JSON of field values", required: true }], bodyParams: ["fields"] },
  ],
};

export const pipedriveRecipe: PlatformRecipe = {
  id: "pipedrive",
  name: "Pipedrive",
  baseUrl: "https://api.pipedrive.com/v1",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "list_deals", description: "List deals.", method: "GET", path: "https://api.pipedrive.com/v1/deals", params: [{ name: "status", type: "string", description: "open, won or lost" }, { name: "limit", type: "number", description: "Results (max 500)" }] },
    { id: "get_deal", description: "Read one deal.", method: "GET", path: "https://api.pipedrive.com/v1/deals/{id}", params: [{ name: "id", type: "string", description: "Deal id", required: true }] },
    { id: "create_deal", description: "Create a deal.", method: "POST", path: "https://api.pipedrive.com/v1/deals", params: [{ name: "title", type: "string", description: "Deal title", required: true }, { name: "value", type: "number", description: "Deal value" }, { name: "currency", type: "string", description: "Currency code" }], bodyParams: ["title", "value", "currency"] },
    { id: "list_persons", description: "List contacts (persons).", method: "GET", path: "https://api.pipedrive.com/v1/persons", params: [{ name: "limit", type: "number", description: "Results" }] },
    { id: "list_activities", description: "List activities (calls, meetings).", method: "GET", path: "https://api.pipedrive.com/v1/activities", params: [{ name: "done", type: "boolean", description: "Filter by done state" }, { name: "limit", type: "number", description: "Results" }] },
  ],
};

export const docuSignRecipe: PlatformRecipe = {
  id: "docusign",
  name: "DocuSign",
  baseUrl: "https://na2.docusign.net",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "list_envelopes", description: "List envelopes (documents out for signature).", method: "GET", path: "https://{accountHost}/restapi/v2.1/accounts/{accountId}/envelopes", params: [{ name: "accountHost", type: "string", description: "Account host, e.g. na2.docusign.net", required: true }, { name: "accountId", type: "string", description: "Account id", required: true }, { name: "from_date", type: "string", description: "Range start (YYYY-MM-DD)" }, { name: "status", type: "string", description: "sent, delivered, completed, declined" }] },
    { id: "get_envelope", description: "Read one envelope's status.", method: "GET", path: "https://{accountHost}/restapi/v2.1/accounts/{accountId}/envelopes/{envelopeId}", params: [{ name: "accountHost", type: "string", description: "Account host", required: true }, { name: "accountId", type: "string", description: "Account id", required: true }, { name: "envelopeId", type: "string", description: "Envelope id", required: true }] },
    { id: "list_envelope_documents", description: "List the documents in an envelope.", method: "GET", path: "https://{accountHost}/restapi/v2.1/accounts/{accountId}/envelopes/{envelopeId}/documents", params: [{ name: "accountHost", type: "string", description: "Account host", required: true }, { name: "accountId", type: "string", description: "Account id", required: true }, { name: "envelopeId", type: "string", description: "Envelope id", required: true }] },
  ],
};

export const datadogRecipe: PlatformRecipe = {
  id: "datadog",
  name: "Datadog",
  // Credential: token = api key, Account = "appKey" (or "appKey|datadoghq.eu"
  // to target the EU site). Both DD-API-KEY and DD-APPLICATION-KEY are required.
  baseUrl: (cred) => `https://api.${cred.account?.split("|")[1] ?? "datadoghq.com"}`,
  auth: ({ token: t, account }) => ({
    "DD-API-KEY": t,
    "DD-APPLICATION-KEY": account?.split("|")[0] ?? "",
  }),
  actions: [
    { id: "list_monitors", description: "List monitors with optional filter.", method: "GET", path: "api/v1/monitor", params: [{ name: "name", type: "string", description: "Name filter" }, { name: "monitor_tags", type: "string", description: "Tag filter" }] },
    { id: "get_monitor", description: "Read one monitor.", method: "GET", path: "api/v1/monitor/{monitorId}", params: [{ name: "monitorId", type: "string", description: "Monitor id", required: true }] },
    { id: "mute_monitor", description: "Mute or unmute a monitor.", method: "POST", path: "api/v1/monitor/{monitorId}/mute", params: [{ name: "monitorId", type: "string", description: "Monitor id", required: true }] },
    { id: "list_events", description: "Query the event stream.", method: "GET", path: "api/v1/events", params: [{ name: "start", type: "string", description: "Epoch seconds", required: true }, { name: "end", type: "string", description: "Epoch seconds", required: true }, { name: "priority", type: "string", description: "normal, low or high" }] },
    { id: "list_hosts", description: "List hosts reporting to Datadog.", method: "GET", path: "api/v1/hosts", params: [{ name: "count", type: "number", description: "Results" }] },
  ],
};

export const pagerDutyRecipe: PlatformRecipe = {
  id: "pagerduty",
  name: "PagerDuty",
  baseUrl: "https://api.pagerduty.com",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}`, accept: "application/vnd.pagerduty+json;version=2" }),
  actions: [
    { id: "list_incidents", description: "List incidents, newest first.", method: "GET", path: "https://api.pagerduty.com/incidents", params: [{ name: "statuses", type: "string", description: "Comma list: triggered,acknowledged,resolved" }, { name: "limit", type: "number", description: "Results (max 100)" }] },
    { id: "get_incident", description: "Read one incident.", method: "GET", path: "https://api.pagerduty.com/incidents/{id}", params: [{ name: "id", type: "string", description: "Incident id", required: true }] },
    { id: "acknowledge_incident", description: "Acknowledge an incident.", method: "PUT", path: "https://api.pagerduty.com/incidents", params: [{ name: "incident", type: "string", description: "JSON {\"incident\":{\"id\":...\",\"type\":\"incident\"}}", required: true }], bodyParams: ["incident"] },
    { id: "list_oncalls", description: "List current on-call entries.", method: "GET", path: "https://api.pagerduty.com/oncalls", params: [] },
    { id: "list_services", description: "List services.", method: "GET", path: "https://api.pagerduty.com/services", params: [{ name: "query", type: "string", description: "Name filter" }] },
  ],
};

export const sentryRecipe: PlatformRecipe = {
  id: "sentry",
  name: "Sentry",
  baseUrl: "https://sentry.io/api/0",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "list_projects", description: "List the token's projects.", method: "GET", path: "https://sentry.io/api/0/projects/", params: [] },
    { id: "list_issues", description: "List an organization's issues.", method: "GET", path: "https://sentry.io/api/0/organizations/{org}/issues/", params: [{ name: "org", type: "string", description: "Organization slug", required: true }, { name: "query", type: "string", description: "e.g. is:unresolved" }, { name: "sort", type: "string", description: "date, freq, new or user" }] },
    { id: "get_issue", description: "Read one issue's details.", method: "GET", path: "https://sentry.io/api/0/issues/{issueId}/", params: [{ name: "issueId", type: "string", description: "Issue id", required: true }] },
    { id: "resolve_issue", description: "Resolve an issue.", method: "PUT", path: "https://sentry.io/api/0/issues/{issueId}/", params: [{ name: "issueId", type: "string", description: "Issue id", required: true }, { name: "status", type: "string", description: "Set to 'resolved'", required: true }], bodyParams: ["status"] },
    { id: "list_releases", description: "List recent releases of an org.", method: "GET", path: "https://sentry.io/api/0/organizations/{org}/releases/", params: [{ name: "org", type: "string", description: "Organization slug", required: true }] },
  ],
};

export const linearRecipe: PlatformRecipe = {
  id: "linear",
  name: "Linear",
  baseUrl: "https://api.linear.app/graphql",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "list_issues", description: "List issues via GraphQL.", method: "POST", path: "https://api.linear.app/graphql", params: [{ name: "query", type: "string", description: "GraphQL query, e.g. { issues { nodes { id title } } }", required: true }], bodyParams: ["query"] },
    { id: "create_issue", description: "Create an issue via GraphQL mutation.", method: "POST", path: "https://api.linear.app/graphql", params: [{ name: "query", type: "string", description: "GraphQL mutation issueCreate(...)", required: true }], bodyParams: ["query"] },
    { id: "list_teams", description: "List teams via GraphQL.", method: "POST", path: "https://api.linear.app/graphql", params: [{ name: "query", type: "string", description: "GraphQL query { teams { nodes { id name } } }", required: true }], bodyParams: ["query"] },
  ],
};

export const gitlabRecipe: PlatformRecipe = {
  id: "gitlab",
  name: "GitLab",
  baseUrl: "https://gitlab.com/api/v4",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "list_projects", description: "List projects the token can access.", method: "GET", path: "https://gitlab.com/api/v4/projects", params: [{ name: "membership", type: "boolean", description: "Only member projects" }, { name: "search", type: "string", description: "Name search" }] },
    { id: "get_project", description: "Read one project.", method: "GET", path: "https://gitlab.com/api/v4/projects/{id}", params: [{ name: "id", type: "string", description: "URL-encoded project path", required: true }] },
    { id: "list_issues", description: "List a project's issues.", method: "GET", path: "https://gitlab.com/api/v4/projects/{id}/issues", params: [{ name: "id", type: "string", description: "Project path or id", required: true }, { name: "state", type: "string", description: "opened or closed" }] },
    { id: "create_issue", description: "Create an issue.", method: "POST", path: "https://gitlab.com/api/v4/projects/{id}/issues", params: [{ name: "id", type: "string", description: "Project path or id", required: true }, { name: "title", type: "string", description: "Issue title", required: true }, { name: "description", type: "string", description: "Issue description" }], bodyParams: ["title", "description"] },
    { id: "list_merge_requests", description: "List a project's merge requests.", method: "GET", path: "https://gitlab.com/api/v4/projects/{id}/merge_requests", params: [{ name: "id", type: "string", description: "Project path or id", required: true }, { name: "state", type: "string", description: "opened, closed or merged" }] },
    { id: "get_merge_request", description: "Read one merge request.", method: "GET", path: "https://gitlab.com/api/v4/projects/{id}/merge_requests/{mr_iid}", params: [{ name: "id", type: "string", description: "Project path or id", required: true }, { name: "mr_iid", type: "string", description: "Merge request iid", required: true }] },
  ],
};

export const dropboxRecipe: PlatformRecipe = {
  id: "dropbox",
  name: "Dropbox",
  baseUrl: "https://api.dropboxapi.com",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "list_folder", description: "List a folder's contents.", method: "POST", path: "https://api.dropboxapi.com/2/files/list_folder", params: [{ name: "path", type: "string", description: "Folder path, '' for root", required: true }, { name: "recursive", type: "boolean", description: "Include subfolders" }], bodyParams: ["path", "recursive"] },
    { id: "search_files", description: "Search files and folders by name.", method: "POST", path: "https://api.dropboxapi.com/2/files/search_v2", params: [{ name: "query", type: "string", description: "Search text", required: true }], bodyParams: ["query"] },
    { id: "get_metadata", description: "Read a file or folder's metadata.", method: "POST", path: "https://api.dropboxapi.com/2/files/get_metadata", params: [{ name: "path", type: "string", description: "Path or id", required: true }], bodyParams: ["path"] },
  ],
};

export const boxRecipe: PlatformRecipe = {
  id: "box",
  name: "Box",
  baseUrl: "https://api.box.com/2.0",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "search_files", description: "Search files across the enterprise.", method: "GET", path: "https://api.box.com/2.0/search", params: [{ name: "query", type: "string", description: "Search text", required: true }, { name: "limit", type: "number", description: "Results (max 100)" }] },
    { id: "list_folder_items", description: "List a folder's items.", method: "GET", path: "https://api.box.com/2.0/folders/{folderId}/items", params: [{ name: "folderId", type: "string", description: "Folder id, '0' for root", required: true }] },
    { id: "get_file", description: "Read a file's metadata.", method: "GET", path: "https://api.box.com/2.0/files/{fileId}", params: [{ name: "fileId", type: "string", description: "File id", required: true }] },
  ],
};

export const calendlyRecipe: PlatformRecipe = {
  id: "calendly",
  name: "Calendly",
  baseUrl: "https://api.calendly.com",
  auth: ({ token: t }) => ({ authorization: `Bearer ${t}` }),
  actions: [
    { id: "get_user", description: "Read the current user.", method: "GET", path: "https://api.calendly.com/users/me", params: [] },
    { id: "list_event_types", description: "List the event types a user offers.", method: "GET", path: "https://api.calendly.com/event_types", params: [{ name: "user", type: "string", description: "User URI", required: true }] },
    { id: "list_scheduled_events", description: "List scheduled events in a range.", method: "GET", path: "https://api.calendly.com/scheduled_events", params: [{ name: "min_start_time", type: "string", description: "Range start (ISO)" }, { name: "max_start_time", type: "string", description: "Range end (ISO)" }, { name: "status", type: "string", description: "active or canceled" }] },
  ],
};

export const xeroRecipe: PlatformRecipe = {
  id: "xero",
  name: "Xero",
  baseUrl: "https://api.xero.com/api.xro/2.0",
  // OAuth2 bearer plus the tenant id header — required on every accounting call
  // after connecting; Account holds the tenant (organisation) id.
  auth: ({ token: t, account }) => ({ authorization: `Bearer ${t}`, "xero-tenant-id": account ?? "" }),
  actions: [
    { id: "list_invoices", description: "List sales invoices.", method: "GET", path: "Invoices", params: [{ name: "where", type: "string", description: "Filter, e.g. Status==\"DRAFT\"" }] },
    { id: "list_contacts", description: "List customer contacts.", method: "GET", path: "Contacts", params: [] },
    { id: "list_accounts", description: "List chart-of-accounts entries.", method: "GET", path: "Accounts", params: [] },
  ],
};

export const confluenceRecipe: PlatformRecipe = {
  id: "confluence",
  name: "Confluence",
  baseUrl: "https://api.atlassian.com",
  // Same credential rules as Jira: bearer OAuth, or Basic for "url|email|token".
  auth: ({ token: t }) => {
    if (t.includes("|")) {
      const [, email, apiToken] = t.split("|");
      if (email && apiToken) return { authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}` };
    }
    return { authorization: `Bearer ${t}` };
  },
  actions: [
    { id: "search_cql", description: "Search pages with CQL.", method: "GET", path: "https://api.atlassian.com/ex/confluence/{cloudid}/rest/api/content/search", params: [{ name: "cloudid", type: "string", description: "Atlassian cloud id", required: true }, { name: "cql", type: "string", description: "CQL, e.g. text ~ 'roadmap'", required: true }, { name: "limit", type: "number", description: "Results (max 100)" }] },
    { id: "get_page", description: "Read a page's content.", method: "GET", path: "https://api.atlassian.com/ex/confluence/{cloudid}/rest/api/content/{pageId}?expand=body.storage", params: [{ name: "cloudid", type: "string", description: "Atlassian cloud id", required: true }, { name: "pageId", type: "string", description: "Page id", required: true }] },
    { id: "create_page", description: "Create a page in a space.", method: "POST", path: "https://api.atlassian.com/ex/confluence/{cloudid}/rest/api/content", params: [{ name: "cloudid", type: "string", description: "Atlassian cloud id", required: true }, { name: "page", type: "string", description: "JSON {\"type\":\"page\",\"title\":...,\"space\":{\"key\":...},\"body\":{...}}", required: true }], bodyParams: ["page"] },
  ],
};

export const ENTERPRISE_RECIPES: PlatformRecipe[] = [
  githubRecipe,
  slackRecipe,
  jiraRecipe,
  confluenceRecipe,
  notionRecipe,
  hubspotRecipe,
  salesforceRecipe,
  pipedriveRecipe,
  sharepointRecipe,
  googleDriveRecipe,
  gmailRecipe,
  googleCalendarRecipe,
  googleSheetsRecipe,
  googleDocsRecipe,
  googleTasksRecipe,
  teamsRecipe,
  outlookMailRecipe,
  outlookCalendarRecipe,
  excelOnlineRecipe,
  zendeskRecipe,
  freshdeskRecipe,
  intercomRecipe,
  serviceNowRecipe,
  stripeRecipe,
  shopifyRecipe,
  mailchimpRecipe,
  twilioRecipe,
  zoomRecipe,
  asanaRecipe,
  mondayRecipe,
  airtableRecipe,
  docuSignRecipe,
  datadogRecipe,
  pagerDutyRecipe,
  sentryRecipe,
  linearRecipe,
  gitlabRecipe,
  dropboxRecipe,
  boxRecipe,
  calendlyRecipe,
  xeroRecipe,
];
