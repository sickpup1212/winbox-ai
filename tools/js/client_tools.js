/* ══════════════════════════════════════════════════════
   CLIENT TOOLS & COMMAND DEFINITIONS
   ====================================================== */

const COMMANDS = {
  help:         { usage: '/help',               desc: 'Show available commands' },
  models:       { usage: '/models',             desc: 'Browse and select an AI model' },
  tables:       { usage: '/tables',             desc: 'List all DB tables' },
  describe:     { usage: '/describe <table>',   desc: 'Show table schema' },
  rows:         { usage: '/rows <table> [n]',   desc: 'Preview table rows' },
  sql:          { usage: '/sql [query]',        desc: 'Run SQL (opens editor if no query)' },
  agent:        { usage: '/agent <task>',       desc: 'Run autonomous DB agent' },
  connect:      { usage: '/connect',            desc: 'Show DB connection status' },
  settings:     { usage: '/settings',           desc: 'Edit API key & model' },
  skills:       { usage: '/skills',             desc: 'Manage AI skills' },
  characters:   { usage: '/characters',        desc: 'Manage roleplay character cards' },
  imagine:      { usage: '/imagine <prompt>',   desc: 'Generate an image from a prompt' },
  auto_imagine: { usage: '/auto_imagine',       desc: 'Auto-generate an image of the current scene' },
  tools:        { usage: '/tools',              desc: 'Manage AI tools' },
  clear:        { usage: '/clear',              desc: 'Clear conversation' },
};

const DESTRUCTIVE_TOOLS = new Set(['drop_table', 'truncate_table', 'delete_rows', 'drop_column']);
const DESTRUCTIVE_SQL_RE = /\b(DROP|TRUNCATE|DELETE|ALTER|UPDATE|GRANT|REVOKE)\b/i;

function isDestructiveSql(sql) {
  return typeof sql === 'string' && DESTRUCTIVE_SQL_RE.test(sql);
}

const FILE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'fs_list_files',
      description: 'List all files in the persistent file store. Returns id, name, folder, language, size, dates.',
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Optional folder path filter, e.g. "/src"' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fs_read_file',
      description: 'Read the full content of a stored file by name and folder.',
      parameters: {
        type: 'object',
        properties: {
          name:   { type: 'string', description: 'Filename, e.g. "utils.py"' },
          folder: { type: 'string', description: 'Folder path, default "/"' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fs_batch_read_files',
      description: 'Read the contents of multiple files in a single call. Provide an array of file objects {name, folder}. Returns an array of file contents.',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name:   { type: 'string', description: 'Filename, e.g. "utils.py"' },
                folder: { type: 'string', description: 'Folder path, default "/"' },
              },
              required: ['name'],
            },
            description: 'List of files to read',
          },
        },
        required: ['files'],
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'fs_write_file',
      description: 'Create or overwrite a file in the persistent store and open it in the editor. Use this when the user asks to save or write a file.',
      parameters: {
        type: 'object',
        properties: {
          name:     { type: 'string', description: 'Filename including extension' },
          folder:   { type: 'string', description: 'Folder path, default "/"' },
          content:  { type: 'string', description: 'Full file content' },
          language: { type: 'string', description: 'Language mode', enum: ['javascript', 'typescript', 'python', 'html', 'css', 'json', 'sql', 'bash', 'markdown', 'yaml', 'xml', 'plain'] }
        },
        required: ['name', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fs_delete_file',
      description: 'Delete a file from the persistent store.',
      parameters: {
        type: 'object',
        properties: {
          name:   { type: 'string', description: 'Filename' },
          folder: { type: 'string', description: 'Folder path, default "/"' }
        },
        required: ['name']
      }
    }
  },
];

const SKILL_READ_TOOL = {
  type: 'function',
  function: {
    name: 'skill_read',
    description: 'Load the full instructions and resources of an AI skill by name. Use this when a task matches a skill\'s description and you need its detailed guidance. Returns the skill\'s SKILL.md instructions and any bundled resource files.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name, e.g. "pdf-processing"' },
      },
      required: ['name'],
    },
  },
};

const CREATE_CUSTOM_TOOL = {
  type: 'function',
  function: {
    name: 'create_custom_tool',
    description: 'Create or update a custom AI tool (a Python function the AI can call). Use this when the user asks you to create a tool, function, or custom capability. Provide a snake_case name, a description of what it does and when to use it, a JSON-schema parameters object, and a Python function body that defines `def run(args): ...` and returns a JSON-serializable value.',
    parameters: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'snake_case function name, e.g. "get_weather"' },
        description: { type: 'string', description: 'What the tool does and when to use it' },
        parameters:  { type: 'object', description: 'JSON schema mapping parameter names to types, e.g. {"city": {"type": "string"}}' },
        body:        { type: 'string', description: 'Python function body. Define `def run(args):` and return a JSON-serializable value, e.g. "def run(args):\\n    return f\\"The weather in {args[\\"city\\"]} is sunny\\""' },
      },
      required: ['name', 'description', 'body'],
    },
  },
};

const CREATE_SKILL_TOOL = {
  type: 'function',
  function: {
    name: 'create_skill',
    description: 'Create or update an AI skill in the skills store. Use this when the user asks you to create a skill, or to package domain expertise, workflows, or best practices for the AI to use automatically. Provide a lowercase-hyphen name, a description of what it does and when to use it, markdown instructions, and optional resource files.',
    parameters: {
      type: 'object',
      properties: {
        name:         { type: 'string', description: 'lowercase letters, numbers, hyphens, e.g. "pdf-processing"' },
        description:  { type: 'string', description: 'What the skill does and when to use it' },
        instructions: { type: 'string', description: 'Markdown instructions (the SKILL.md body): workflows, best practices, step-by-step guidance' },
        resources:    { type: 'array', items: { type: 'object' }, description: 'Optional array of {name, content} reference files' },
      },
      required: ['name', 'description', 'instructions'],
    },
  },
};

const EDITOR_TOOL = {
  type: 'function',
  function: {
    name: 'open_editor',
    description: 'Opens a text or code editor window and writes content into it. Use this whenever the user asks you to write a document, script, configuration file, or any block of code or text. The editor appears as a floating window the user can read, edit, copy, and save.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Filename including extension, e.g. "script.py", "notes.md", "config.json"' },
        content:  { type: 'string', description: 'The full text or code to write into the editor' },
        language: {
          type: 'string',
          description: 'Language/format for the editor mode',
          enum: ['javascript', 'typescript', 'python', 'html', 'css', 'json', 'sql', 'bash', 'markdown', 'yaml', 'xml', 'plain'],
        },
      },
      required: ['filename', 'content'],
    },
  },
};

const GENERATE_IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: 'Generate an image from a text prompt using the configured image-generation provider (e.g. Venice). Use this when the user asks you to create, draw, or generate an image, or when a roleplay scene would benefit from a visual. Returns the generated image and displays it in the chat.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed description of the image to generate' },
        model:  { type: 'string', description: 'Image model id, e.g. "ideogram-v4" (defaults to provider default)' },
        size:   { type: 'string', description: 'Image size, e.g. "1024x1024" (defaults to 1024x1024)' },
      },
      required: ['prompt'],
    },
  },
};

const SUBAGENT_TOOL = {
  type: 'function',
  function: {
    name: 'run_subagent',
    description: 'Run an autonomous database subagent to execute a complex multi-step database task. The subagent plans and executes SQL and schema tools independently and returns a final summary.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Detailed description of the database task to accomplish.' },
      },
      required: ['task'],
    },
  },
};

function filterToolsForAgent(allTools, agentToolsStr) {
  if (!agentToolsStr || typeof agentToolsStr !== 'string') return allTools;
  const rawTokens = agentToolsStr.split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!rawTokens.length || rawTokens.includes('*') || rawTokens.includes('all')) return allTools;

  return allTools.filter(tool => {
    const fnName = (tool.function?.name || '').toLowerCase();

    // Exact name match
    if (rawTokens.includes(fnName)) return true;

    // Toolkit groups
    for (const token of rawTokens) {
      if ((token === 'files' || token === 'fs' || token === 'file') && fnName.startsWith('fs_')) return true;
      if ((token === 'db' || token === 'database' || token === 'sql') &&
          !fnName.startsWith('fs_') && fnName !== 'open_editor' && fnName !== 'generate_image' &&
          fnName !== 'skill_read' && fnName !== 'create_skill' && fnName !== 'create_custom_tool' &&
          fnName !== 'run_subagent') return true;
      if ((token === 'editor' || token === 'write') && fnName === 'open_editor') return true;
      if ((token === 'image' || token === 'imagine') && fnName === 'generate_image') return true;
      if ((token === 'skills' || token === 'skill') && (fnName === 'skill_read' || fnName === 'create_skill')) return true;
      if ((token === 'custom') && fnName === 'create_custom_tool') return true;
      if ((token === 'subagent' || token === 'agent') && fnName === 'run_subagent') return true;
    }
    return false;
  });
}
