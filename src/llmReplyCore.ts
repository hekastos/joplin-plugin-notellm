import joplin from '../api';
import { get_txt_by_locale } from './texts';
import { get_llm_options } from './llmConf';
import {
    FLOATING_HTML_BASIC, FLOATING_HTML_THINKING, FLOATING_HTML_WAITING,
    COLOR_FLOAT, makeJumpingHtml, FloatProgressAnimator,
    add_short_floating, get_random_floatid
} from './pluginFloatingObject';
import { mcp_call_tool, mcp_get_tools, mcp_get_tools_openai, get_mcp_prompt } from './mcpClient';

// 
/**
 * Scroll the view to the cursor position
 */
export async function scroll_to_view(mode: string = 'none') {
    if (mode === 'desktop') {
        await joplin.commands.execute('editor.execCommand', {
            name: 'cm-moveCursorToSelectionEnd'
        });
    }
    else if (mode === 'mobile') {
        await joplin.commands.execute('editor.execCommand', {
            name: 'cm-scrollToCursor'
        });
    }
    else {
        // Do nothing for other modes
    }
}

function formatDateTime(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0'); // Month is 0-indexed, so +1
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function formatNow() {
    const now = new Date();
    return formatDateTime(now);
}

/**
 * Calculate the overlap length between the tail of string A and the head of string B
 * @param strA 
 * @param strB 
 * @returns Overlap length as integer
 */
function getOverlapLength(strA: string, strB: string): number {
    // 1. Maximum possible overlap is limited by the shorter of the two strings
    const maxOverlap = Math.min(strA.length, strB.length);
    // 2. Iterate from max length downward, checking if A's suffix equals B's prefix
    for (let n = maxOverlap; n > 0; n--) {
        const suffixA = strA.slice(-n); // Last n characters of A
        const prefixB = strB.slice(0, n); // First n characters of B
        if (suffixA === prefixB) {
            return n; // Found maximum match, return immediately
        }
    }
    // 3. No suffix-prefix match found
    return 0;
}
//
/**
 * Check if the server is available
 * @param {string} url Server address to check
 * @param {number} [timeout=1000] Timeout in milliseconds
 * @returns {Promise<{status: 'online' | 'offline' | 'timeout' | 'error', message: string}>}
 */
async function checkServerStatus(url: string,
    timeout: number = 1000): Promise<{ status: 'online' | 'offline' | 'timeout' | 'error'; message: string; }> {
    //
    // AbortController is key to implementing timeout
    const controller = new AbortController();
    const signal = controller.signal;

    // Set a timer to abort the fetch request after timeout
    const timeoutId = setTimeout(() => {
        console.log(`Request to ${url} timed out.`);
        controller.abort();
    }, timeout);

    try {
        // Initiate fetch request
        // We use 'HEAD' method because it only fetches response headers, which is fastest.
        // 'no-cors' mode can avoid some cross-origin issues, but see important notes below.
        const response = await fetch(url, {
            method: 'HEAD', // Use HEAD method, only requests headers, fast
            mode: 'no-cors', // Use no-cors mode to test connectivity even with CORS restrictions
            signal: signal   // Pass AbortSignal to fetch
        });

        // If request succeeds, clear the timeout timer
        clearTimeout(timeoutId);

        // For 'no-cors' mode, we cannot read response.status or response.ok
        // As long as the request doesn't throw an error, we consider it reachable at network level.
        // This is a basic connectivity check.
        return {
            status: 'online',
            message: `Server ${url} is reachable on the network.`
        };

    } catch (err) {
        // Clear the timeout timer just in case
        clearTimeout(timeoutId);

        // Determine error type
        if (err.name === 'AbortError') {
            return {
                status: 'timeout',
                message: `Connection to server ${url} timed out (exceeded ${timeout}ms).`
            };
        }

        // Other network errors (e.g., DNS lookup failed, server refused connection, etc.)
        return {
            status: 'offline',
            message: `Unable to connect to server ${url}. Error: ${err.message}`
        };
    }
}

/**
 * Create a delay function that yields control
 * 
 * @param ms Delay in milliseconds
 */
function sleep_ms(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

//
/**
 * Get the cursor position
 * @returns A dictionary like: {
    "startPosition": {
        "line": 1,
        "column": 0
    },
    "startLine": {
        "from": 0,
        "to": 50,
        "number": 1,
        "text": "line content"
    },
    "startCol": 0,
    "endPosition": {
        "line": 1,
        "column": 0
    },
    "endLine": {
        "from": 0,
        "to": 50,
        "number": 1,
        "text": "line content"
    },
    "endCol": 0
}
 */
async function get_cursor_pos() {
    let tmp_cur = await joplin.commands.execute('editor.execCommand', {
        name: 'cm-getCursorPos'
    });
    return tmp_cur;
}


/**
 * For chat only. 
 * Split long text to dialog list, including role and content.
 */
export function splitTextToMessages(raw: string, remove_think: boolean = true) {

    const lines = raw.split(/\r?\n/);
    // let remove_think = true;
    let result = [];
    let buffer = [];
    let currentRole = "user";
    let inResponse = false;
    let responder = null;

    // Helper function: merge buffer into result
    function flushBuffer(role: string) {
        if (buffer.length === 0) return;
        const content = buffer.join('\n');
        // Merge into result if the previous role is the same
        if (result.length > 0 && result[result.length - 1].role === role) {
            result[result.length - 1].content += '\n' + content;
        } else {
            result.push({ role, content });
        }
        buffer = [];
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for start marker
        const startMatch = line.match(/^\*\*Response from (.+):\*\*$/);
        if (startMatch) {
            // Flush previous content first
            flushBuffer(currentRole);

            // Start new wrapper
            inResponse = true;
            responder = startMatch[1].trim();
            // currentRole = responder;
            currentRole = "assistant";
            continue;
        }

        // Check for end marker
        if (line.trim() === '\*\*End of response\*\*') {
            flushBuffer(currentRole);
            inResponse = false;
            responder = null;
            currentRole = "user";
            continue;
        }

        // Process content
        buffer.push(line);
    }

    // Process remaining content
    flushBuffer(currentRole);

    // Remove purely empty content
    // const cleanResult = result.filter(item => item.content.trim() !== '');

    // Remove <think> </think> sections 
    // TODO: If <think> </think> appears in body text, there may be a bug, but it doesn't affect display, so observing for now
    if (remove_think && result.length > 0) {
        for (let i = 0; i < result.length; i++) {
            if (result[i].role === "assistant") {
                let content = result[i].content;
                // let content_without_think = content.trim().replace(/^<think>[\s\S]*?<\/think>/, '').trimStart();  // Only process the first one
                let content_without_think = content.trim().replace(/<think>[\s\S]*?<\/think>/g, '').trimStart();  // g means global replacement
                result[i].content = content_without_think;
            }
            else {
                result[i].content = result[i].content.trim();
            }
        }
    }
    //
    return result;
}

export async function llmReplyStream({
    inp_str,
    lst_msg = [],
    query_type = 'chat',
    is_selection_exists = true,
    str_before = '',
    str_after = '',
    lst_tools_input = [],
    round_tool_call = 0,
    flags = null
}) {
    //
    const locale = await joplin.settings.globalValue('locale');
    let dictText = await get_txt_by_locale();
    //
    console.log('inp_str = ', inp_str);
    console.log('lst_msg = ', lst_msg);
    console.log('lst_tools_input = ', lst_tools_input);
    //
    // flags
    let llmSettingFlags = await joplin.settings.values(['llmFlagLlmRunning'])
    let is_running = parseInt(String(llmSettingFlags['llmFlagLlmRunning']));
    async function on_before_return() {
        await joplin.settings.setValue('llmFlagLlmRunning', 0);
    }
    if (round_tool_call <= 0) { // Entry layer
        if (is_running == 1) { // Already running, force stop
            await on_before_return();
            alert('Force stopped!')
            return;
        }
        else if (is_running == 0) { // 
            await joplin.settings.setValue('llmFlagLlmRunning', 1);
        }
    }
    else {  // Inner layer
        if (is_running == 0) { // Inner layer entered in non-running state, stop directly
            // await on_before_return();
            // alert('Force stopped!')
            return;
        }
    }
    // ===============================================================
    let apiModel = '', apiUrl = '', apiKey = '', extraConfig: any;
    let mcp_number = 0;
    let apiTemperature = 0;
    let apiMaxTokens = 0;
    let scroll_method = 'desktop';
    let prompt_for_chat = '';
    // let llmSettingValues: any = {};
    let llmSelect = 0;
    // Use unified parameter reading function
    const dict_llm = await get_llm_options();
    try {
        // Extract parameters
        apiModel = dict_llm['model'];
        apiUrl = dict_llm['url'];
        apiKey = dict_llm['key'];
        extraConfig = dict_llm['extra_config'];
        mcp_number = dict_llm['mcp_number'];
        apiTemperature = dict_llm['temperature'];
        apiMaxTokens = dict_llm['maxTokens'];
        scroll_method = dict_llm['scroll_method'];
        prompt_for_chat = dict_llm['chatPrompt'];
        // llmSettingValues = dict_llm['allSettingValues'];
        llmSelect = dict_llm['llmSelect'];
    }
    catch (err) {
        alert(`ERROR 210: ${err}`);
        await on_before_return();
        return;
    }
    // If key parameters are missing, report error directly without proceeding
    if (apiModel.trim() === '' || apiUrl.trim() === '' || apiKey.trim() === '') {
        alert(`ERROR 57: ${dictText['err_llm_conf']}`);
        await on_before_return();
        return;
    }
    //
    // MCP related parameters
    const lst_mcp_setting_keys = ['llmMcpEnabled'];
    const N_MAP_MAX = 42
    for (let n = 1; n <= N_MAP_MAX; n++) {
        let n_mcp = String(n).padStart(2, "0");
        lst_mcp_setting_keys.push('llmMcpEnabled_' + n_mcp)
        lst_mcp_setting_keys.push('llmMcpServer_' + n_mcp)
        lst_mcp_setting_keys.push('llmMcpHeaders_' + n_mcp)
    }
    const dict_mcp_settings = await joplin.settings.values(lst_mcp_setting_keys);  // Read settings
    //
    let mcp_servers_str = ''; // Concatenated MCP server URLs
    let mcp_headers_str = ''; // Concatenated MCP server headers
    if (Number(dict_mcp_settings['llmMcpEnabled']) > 0) { // MCP main switch
        for (let n = 1; n <= N_MAP_MAX; n++) {
            let n_mcp = String(n).padStart(2, "0");
            if (dict_mcp_settings['llmMcpEnabled_' + n_mcp]) { // If enabled
                let mcp_server_one = String(dict_mcp_settings['llmMcpServer_' + n_mcp]);
                let mcp_headers_one = String(dict_mcp_settings['llmMcpHeaders_' + n_mcp] || '');
                if (mcp_server_one.trim().length > 0) {
                    if (mcp_servers_str.length <= 0) {
                        mcp_servers_str = mcp_server_one.trim();
                        mcp_headers_str = mcp_headers_one.trim();
                    }
                    else {
                        mcp_servers_str = mcp_servers_str + '|' + mcp_server_one.trim();
                        mcp_headers_str = mcp_headers_str + '|' + mcp_headers_one.trim();
                    }
                }
            }
        }
    }
    // const MCP_SERVER = String(llmSettingValues['llmMcpServer']); // Read settings
    const MCP_SERVER = mcp_servers_str;
    const MCP_HEADERS = mcp_headers_str;
    const MAX_TOOL_CALL_ROUND = 5; // Limit MCP recursive call count
    //
    let IS_MCP_ENABLED = (mcp_number > 0 && MCP_SERVER.trim().length > 0);
    if (IS_MCP_ENABLED) {
        // Check if server is available
        /*
        let is_mcp_server_available = await checkServerStatus(MCP_SERVER);
        if (is_mcp_server_available.status != 'online') {
            console.info('MCP server unavailable')
            IS_MCP_ENABLED = false;
        }
        */
        // Check if too many rounds
        if (round_tool_call > MAX_TOOL_CALL_ROUND) {
            IS_MCP_ENABLED = false;
        }
    }
    let MCP_MODE = 'mcp'  // agent, mcp, null
    if (mcp_number == 10) {
        MCP_MODE = 'mcp'
    }
    else if (mcp_number == 20) {
        MCP_MODE = 'agent'
    }
    //
    //////
    //
    const START_NOTE = await joplin.workspace.selectedNote(); // Note at start
    // 
    let result_whole = '' // Store complete document generated by this reply. Seems unused though?
    let cursor_pos: any;  // Cursor position
    //
    // head and tail
    const HEAD_TAIL_ENTER_COUNT = 2
    const CHAT_HEAD = `Response from ${apiModel}:`;  // No need to bold
    const CHAT_TAIL = '**End of response**';
    if (flags === null) {
        flags = {
            head_printed: false,
            tail_printed: false
        }
    }
    // Print CHAT_HEAD
    const print_head = async () => {
        await insert_content_move_view(`\n\n**${CHAT_HEAD}**` + '\n'.repeat(HEAD_TAIL_ENTER_COUNT), false);
    }
    const print_tail = async (n_enter_before = 0) => {
        // 避免回车次数过多
        let n_enter = n_enter_before > HEAD_TAIL_ENTER_COUNT ? 0 : HEAD_TAIL_ENTER_COUNT - n_enter_before;
        await insert_content_move_view('\n'.repeat(n_enter) + `${CHAT_TAIL}\n\n`, false);
    }
    //
    // Text animation parameters
    const ANIMATION_INTERVAL_MS = 120;
    // ===============================================================
    // 
    /**
     * Update reply in note in real-time,
     * Depends on external variables: result_whole, cursor_pos
     * @param new_text 
     * @param need_save 
     * @returns 
     */
    async function insert_content_move_view(new_text: string, need_save_text = true) {
        // If note switched, force exit
        let current_note = await joplin.workspace.selectedNote();
        if (current_note.id != START_NOTE.id) {
            // alert('ERROR: ' + dictText['err_note_changed'])
            await on_animation_error();
            throw new Error('Note changed error!')
        }
        // Jump to last cursor position
        try {
            let last_pos = cursor_pos.startLine.from + cursor_pos.startPosition.column;
            await joplin.commands.execute('editor.execCommand', {
                name: 'cm-moveCursorPosition',
                args: [last_pos, false]
            });
        }
        catch (e) {
            console.log(`Error = ${e}`)
        }
        //
        // Logic (to verify): before first output, print header first TODO
        if (new_text.length > 0) { // No need to trim, spaces or newlines are also output
            if (result_whole.length <= 0) {
                if (!flags.head_printed) {
                    await joplin.commands.execute('insertText', `\n\n**${CHAT_HEAD}**` + '\n'.repeat(HEAD_TAIL_ENTER_COUNT));
                    flags.head_printed = true;
                }
            }
            flags.head_printed = true;
        }
        // Append new content to result
        if (need_save_text) {
            result_whole += new_text;
        }
        // Scroll
        await scroll_to_view(scroll_method);
        //
        // Save latest cursor position
        cursor_pos = await joplin.commands.execute('editor.execCommand', {
            name: 'cm-getCursorPos'
        });
    }

    // Move cursor to end of selection
    await joplin.commands.execute('editor.execCommand',
        { name: 'cm-moveCursorToSelectionEnd' }
    );
    // Scroll to cursor position
    await scroll_to_view(scroll_method);
    //
    // Initialize cursor position
    try {
        cursor_pos = await get_cursor_pos();
    }
    catch (err) {
        // Failed to get cursor position, related to editor version.
        console.warn('Error: cm-getCursorPos:', err);
        await on_animation_error();
    }
    // 
    // ===============================================================
    //
    // Build message list
    let prompt_messages = [];
    // If provided, use directly
    if (lst_msg.length > 0) {
        prompt_messages = lst_msg;
    }
    else {
        // Auto-add current time
        const ADD_CURRENT_TIME = true;
        if (ADD_CURRENT_TIME) {
            prompt_messages.push({ role: 'system', content: `<current_time> ${formatNow()} </current_time>` });
        }
        // Basic parameters
        let chatType = parseInt(String(dict_llm['chatType']));
        let prompt_head = 'You are a helpful assistant.';
        //
        // Chat message list
        if (query_type === 'chat' && chatType == 1) {
            if (prompt_for_chat.trim() === '') {
                prompt_head = dictText['prompt_chat'];
            }
            else {
                prompt_head = prompt_for_chat.trim();
            }
        }
        prompt_messages.push({ role: 'system', content: prompt_head });
        //
        // MCP prompt

        if (IS_MCP_ENABLED) { // MCP condition check could perhaps be moved earlier.
            prompt_messages.push({ role: 'system', content: get_mcp_prompt() });
        }
        prompt_messages.push({ role: 'system', content: 'Response in user query language.' })
        //
        if (query_type === 'chat' && chatType == 1) {
            let lstSplited = splitTextToMessages(inp_str);
            prompt_messages = prompt_messages.concat(lstSplited);
            console.log(prompt_messages);
        }
        else {
            prompt_messages.push({ role: 'user', content: inp_str });
        }
    }
    //
    // ===============================================================
    // waiting animation
    const show_waiting = true;
    const waitingAnimator = new FloatProgressAnimator('notellm_waiting_anim', show_waiting, FLOATING_HTML_WAITING);
    //
    // think animation
    const hide_thinking = Number(dict_llm['chatSkipThink']) === 1;
    const thinkingAnimator = new FloatProgressAnimator('notellm_thinking_anim', hide_thinking, FLOATING_HTML_THINKING, COLOR_FLOAT.NORMAL);
    let thinking_status = 'not_started';
    //
    // Start waiting
    async function on_wait_start() {
        await waitingAnimator.start();
    }
    // End waiting
    async function on_wait_end() {
        await waitingAnimator.stop();
    }
    //
    // Start thinking
    async function on_think_start() {
        await thinkingAnimator.start();
    }
    // Thinking in progress
    async function think_going() {
    }
    // End thinking
    async function on_think_end() {
        await thinkingAnimator.stop();
    }
    async function on_llm_end() {
        //
    }
    async function on_animation_error() {
        await on_wait_end();
        await on_think_end();
    }
    //
    // ============= ================= ==============
    // Main process starts
    // 
    // Upon entry, immediately start wait phase;
    try {
        await on_wait_start();
    }
    catch {
        await on_wait_end();
    }
    //
    // Build request body
    // Check if this is an OpenAI reasoning model (o1, o3, etc.) or GPT-5.x model which requires different parameters
    // - o-series (o1, o3, o4): use max_completion_tokens, no temperature
    // - gpt-5.x series: use max_completion_tokens, no temperature (unless reasoning.effort is "none")
    const isOSeriesModel = /^(o1|o3|o4)(-|$)/i.test(apiModel);
    const isGPT5Model = /^gpt-5/i.test(apiModel);
    const isNewModel = isOSeriesModel || isGPT5Model;

    let requestBody: any = {
        model: apiModel, // Model name
        messages: prompt_messages,
        stream: true, // Enable streaming output
    };

    // Handle token limits based on model type
    if (isNewModel) {
        // GPT-5.x and o-series use max_completion_tokens
        requestBody.max_completion_tokens = apiMaxTokens;
    } else {
        // Standard models use max_tokens and temperature
        requestBody.temperature = apiTemperature;
        requestBody.max_tokens = apiMaxTokens;
    }
    //
    // ============= ================= ==============
    // Tool MCP
    //
    let MCP_SERVER_URL_RESTFUL = '';
    if (MCP_MODE === 'mcp') {
        MCP_SERVER_URL_RESTFUL = MCP_SERVER + '/mcp/get_tools'
    }
    else if (MCP_MODE === 'agent') {
        MCP_SERVER_URL_RESTFUL = MCP_SERVER + '/mcp/get_agents'
    }
    //
    let openai_tools: any;
    let openai_map: any
    if (IS_MCP_ENABLED) {
        //
        // First get tool list for message body assembly
        if (lst_tools_input.length > 0) { // Directly specify tool list, no need to fetch
            requestBody['tools'] = lst_tools_input;
            requestBody['temperature'] = 0;
        }
        else {  // Get available tool list
            openai_tools = await mcp_get_tools_openai(MCP_SERVER, MCP_HEADERS);
            openai_map = openai_tools['tmap'];
            //
            if (openai_tools['tools'].length > 0) {  // Need more format validation
                requestBody['tools'] = openai_tools['tools'];
            }
        }
    }
    /**
     * Display toast only, no actual functionality.
     * 
     * When calling tool, display tool name
     * @param tool_name 
     */
    async function on_tool_call_start(tool_name: string, server_name: string = '') {
        let mcp_text = `[${MCP_MODE}]`
        if (server_name.trim().length > 0) {
            mcp_text += `Calling ${server_name}.${tool_name}, please wait...`
        }
        else {
            mcp_text += `Calling ${tool_name}, please wait...`
        }
        await joplin.commands.execute('editor.execCommand', {
            name: 'cm-addFloatingObject',
            args: [{
                text: makeJumpingHtml(mcp_text),
                floatId: 'on_tool_call_start',
                bgColor: COLOR_FLOAT.NORMAL
            }]
        });
    }
    async function on_tool_call_end(tool_name: string) {
        await joplin.commands.execute('editor.execCommand', {
            name: 'cm-removeFloatingObject',
            args: ['on_tool_call_start']
        });
    }
    //
    // Override existing config items based on custom settings
    try {
        if (extraConfig.trim().length > 0) {
            let newConfig = JSON.parse(extraConfig);
            requestBody = { ...requestBody, ...newConfig };
        }
        console.log(JSON.stringify(requestBody));
    }
    catch (err) {
        console.warn('JSON parse failed:', err);
    }
    //
    // Initiate HTTP request
    let llm_response: any;
    try {
        let dict_headers = {
            'User-Agent': 'NoteLLM',
            // 'X-Client-Name':'NoteLLM', // This line may cause gemini to block, so don't add it
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`, // Set API key
        }
        // Special handling for Claude:
        if (apiUrl.includes('api.anthropic.com')) {
            dict_headers['anthropic-dangerous-direct-browser-access'] = 'true';  // Request header must be string
        }
        //
        llm_response = await fetch(apiUrl, {
            method: 'POST',
            headers: dict_headers,
            body: JSON.stringify(requestBody), // Serialize request body to JSON
        });
        // Check HTTP response status
        if (!llm_response.ok || !llm_response.body) {
            const errorText = await llm_response.text();
            console.error('Error from LLM API:', errorText);
            alert(`ERROR 156: ${llm_response.status} ${llm_response.statusText} ${errorText}`);
            await on_before_return();
            await on_animation_error();
            return;
        }
    }
    catch (err) {
        //
        // Network error or CORS restriction. In this case response is empty object.
        if (err.message.includes('Failed to fetch')) {
            console.error('Error 173:', err);
            alert(`Error 173: ${err}. \n ${dictText['err_cors']}`);
        }
        else {
            console.error('Error 177:', err);
            alert(`ERROR 177: ${err} \n llm_response = ${llm_response}.`);
        }
        await on_before_return();
        await on_animation_error();
        return;
    }
    finally {
        // Nothing to do here for now
    }
    //
    // Output parsing section =============================
    //
    //
    let dict_res_all = {
        "res_whole": "",
        "res_content": "",
        "res_tool": "",
        "res_think": "",
        "finist_reason": "",
        "delta_content": "",
        "delta_think": "",
        "delta_tool": "",
        "thinking_status": "not_started",
        "think_word_start": "",
    }
    /**
     * split openai-api response
     * 
     * 拆解AI回复文本，找到思考部分、文本部分。
     * 
     * 依赖于 外部变量 dict_res_all。
     * 
     * @param str_delta_parsed 
     */
    function response_split_stream(str_delta_parsed: string) {
        //
        dict_res_all['res_whole'] += str_delta_parsed;
        //
        const METHOD_TYPE: string = 'METHOD_2';
        //
        if (METHOD_TYPE === 'METHOD_1') { // 最简单版本，找开头词语、结束词语
            const WORD_THINK_START = '<think>';
            const WORD_THINK_END = '</think>';
            const lastOpen = dict_res_all['res_whole'].indexOf(WORD_THINK_START);
            const lastClose = dict_res_all['res_whole'].indexOf(WORD_THINK_END);
            //
            if (lastOpen >= 0) { // 如果存在思考
                if (lastClose > 0 && lastClose > lastOpen) {  // 思考完成
                    let str_think = dict_res_all['res_whole'].slice(lastOpen + WORD_THINK_START.length, lastClose);
                    let str_content = dict_res_all['res_whole'].slice(lastClose + WORD_THINK_END.length);
                    str_content = str_content.replace(/^\n+/g, ''); // 避免解析出来的 content 以回车开头
                    dict_res_all['delta_think'] = str_think.startsWith(dict_res_all['res_think']) ? str_think.slice(dict_res_all['res_think'].length) : null; // 
                    dict_res_all['res_think'] = str_think;
                    dict_res_all['delta_content'] = str_content.startsWith(dict_res_all['res_content']) ? str_content.slice(dict_res_all['res_content'].length) : null; // 
                    dict_res_all['res_content'] = str_content;
                    dict_res_all['thinking_status'] = 'think_end';
                }
                else { // 思考中
                    let str_think = dict_res_all['res_whole'].slice(lastOpen + WORD_THINK_START.length, lastClose);
                    dict_res_all['delta_think'] = str_think.startsWith(dict_res_all['res_think']) ? str_think.slice(dict_res_all['res_think'].length) : null; // 
                    dict_res_all['res_think'] = str_think;
                    dict_res_all['thinking_status'] = 'think_start';
                }
            }
            else { // 一开始就没有思考的话
                dict_res_all['res_content'] += str_delta_parsed;
                dict_res_all['delta_content'] = str_delta_parsed;
                dict_res_all['thinking_status'] = 'think_end';
            }
            //
            // 避免 content 以回车开头
            dict_res_all['res_content'] = dict_res_all['res_content'].replace(/^\n+/g, '');
        }
        // //
        else if (METHOD_TYPE === 'METHOD_2') { // 方法2：逐行判断
            //
            if (dict_res_all.thinking_status === 'think_end') {
                dict_res_all['res_content'] += str_delta_parsed;
                if (dict_res_all['res_content'].startsWith('\n')) {
                    dict_res_all['res_content'] = dict_res_all['res_content'].trimStart();
                    dict_res_all['delta_content'] = str_delta_parsed.trimStart();
                }
                else {
                    dict_res_all['delta_content'] = str_delta_parsed;
                }
            }
            else {
                // 按 \n 分割，并移除首尾空白
                const segments = dict_res_all.res_whole.split('\n').map(s => s.trim());
                // 逐行遍历
                let lastOpenLineIndex = -1;
                let lastCloseLineIndex = -1;
                // let thinkWordStart = '';
                //
                for (let i = 0; i < segments.length; i++) {
                    if (dict_res_all.thinking_status === 'not_started') {
                        if (segments[i] === '<think>' || segments[i] == '*Thinking...*') {
                            lastOpenLineIndex = i;
                            dict_res_all.thinking_status = 'think_start';
                            dict_res_all.think_word_start = segments[i];
                        }
                        else if (segments[i].length <= 0) { // 空行，暂不判断
                            continue;
                        }
                        else { // 出现其他开头，说明不需要思考
                            dict_res_all.thinking_status = 'think_end';
                            dict_res_all.res_content += segments[i];
                            dict_res_all.delta_content = segments[i];
                            break;
                        }
                    }
                    //
                    else if (dict_res_all.thinking_status === 'think_start') {
                        console.log('[847] segments[i] = ', segments[i]);
                        console.log(dict_res_all.think_word_start);
                        if (dict_res_all.think_word_start === '<think>') {
                            if (segments[i] === '</think>') {
                                lastCloseLineIndex = i + 1; // 为了think包括当前词汇
                                dict_res_all.thinking_status = 'think_end';
                                let segments_origional = dict_res_all.res_whole.split('\n');
                                let str_think = segments_origional.slice(lastOpenLineIndex, lastCloseLineIndex - 1).join("");
                                dict_res_all['delta_think'] = str_think.startsWith(dict_res_all['res_think']) ? str_think.slice(dict_res_all['res_think'].length) : null; // 
                                dict_res_all['res_think'] = str_think;
                                break;
                            }
                        }
                        else if (dict_res_all.think_word_start === '*Thinking...*') {
                            if (i >= 1) {
                                if (!segments[i].startsWith('>') && segments[i].length > 0 && segments[i - 1].startsWith('>')) {
                                    lastCloseLineIndex = i;
                                    dict_res_all.thinking_status = 'think_end';
                                    let segments_origional = dict_res_all.res_whole.split('\n');
                                    let str_think = segments_origional.slice(lastOpenLineIndex, lastCloseLineIndex).join("");
                                    dict_res_all['delta_think'] = str_think.startsWith(dict_res_all['res_think']) ? str_think.slice(dict_res_all['res_think'].length) : null; // 
                                    dict_res_all['res_think'] = str_think;
                                    break;
                                }
                            }
                        }
                        else {
                            console.log('[860] segments[i] = ', segments[i])
                        }
                    }
                }
                // 根据末尾状态，判断新增处理方式；
                // 进入此处的条件是 进入的时候尚未处于 think_end
                if (dict_res_all.thinking_status == 'think_end') { // 不处于思考
                    // 找到增量的思考部分与内容部分
                    let segments_origional = dict_res_all.res_whole.split('\n');
                    let str_think: string = '';
                    if (dict_res_all.think_word_start === '<think>') {
                        str_think = segments_origional.slice(lastOpenLineIndex, lastCloseLineIndex - 1).join("");
                    }
                    else if (dict_res_all.think_word_start === '*Thinking...*') {
                        str_think = segments_origional.slice(lastOpenLineIndex, lastCloseLineIndex).join("");
                    }
                    let str_content = segments_origional.slice(lastCloseLineIndex).join("");
                    str_content = str_content.replace(/^\n+/g, ''); // 避免解析出来的 content 以回车开头
                    dict_res_all['delta_think'] = str_think.startsWith(dict_res_all['res_think']) ? str_think.slice(dict_res_all['res_think'].length) : null; // 
                    dict_res_all['res_think'] = str_think;
                    dict_res_all['delta_content'] = str_content.startsWith(dict_res_all['res_content']) ? str_content.slice(dict_res_all['res_content'].length) : null; // 
                    dict_res_all['res_content'] = str_content;
                    console.log('[869] dict_res_all = ', JSON.stringify(dict_res_all, null, 2))
                }
                else if (dict_res_all.thinking_status == 'think_start') { // 结尾 thinking
                    let segments_origional = dict_res_all.res_whole.split('\n');
                    let str_think = segments_origional.slice(lastOpenLineIndex, lastCloseLineIndex).join("");
                    dict_res_all['delta_think'] = str_think.startsWith(dict_res_all['res_think']) ? str_think.slice(dict_res_all['res_think'].length) : null; // 
                    dict_res_all['res_think'] = str_think;
                }
            }
        }
        //
        console.log('[880] dict_res_all = ', JSON.stringify(dict_res_all, null, 2))
        return dict_res_all['delta_content'];
    }
    //
    let reply_type = 'unknown';  // Type classification for this request (tool call or not)
    let is_stream_done = false;
    let lst_tool_calls = [];
    let force_stop = false;  // Force exit
    let fail_count = 0;
    const FAIL_COUNT_MAX = 5;
    let output_str = '';
    let flag_head_to_write = true; // Temporary flag for head printing logic
    let need_add_head = true;

    try {
        const reader = llm_response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        while (!is_stream_done) {
            // Yield control to activate external processes
            sleep_ms(0);
            //
            // Exit after note switch
            let current_note = await joplin.workspace.selectedNote();
            if (current_note.id != START_NOTE.id) {
                alert('ERROR: ' + dictText['err_note_changed'])
                await on_animation_error();
                await on_before_return();
                return;
            }
            // Exit after consecutive failures
            if (fail_count >= FAIL_COUNT_MAX) {
                alert(dictText['err_wrong'])
                await on_animation_error();
                break;
            }
            // Force exit
            let llmSettingFlags_inner = await joplin.settings.values(['llmFlagLlmRunning'])
            let is_running_inner = parseInt(String(llmSettingFlags_inner['llmFlagLlmRunning']));
            if (is_running_inner == 0) {
                force_stop = true;
            }
            if (force_stop) {
                await on_animation_error();
                await on_before_return();
                return;
            }
            //
            const { done, value } = await reader.read();  // 获取返回的片段
            if (done) {
                is_stream_done = true;
                await on_wait_end();
                await on_think_end();
                break; // Exit loop when stream ends
            }
            //
            // Decode and parse data chunk
            const chunk: string = decoder.decode(value, { stream: true });
            // console.info('Stream Chunk = ', chunk);
            //
            // Parse JSON lines
            if (typeof chunk === "string") {  // Chunk as whole, may receive multiple lines, each starts with data: or is empty line
                //
                // As long as there's feedback, can stop waiting message
                // await on_wait_end();
                //
                for (const data_line of chunk.split('\n')) { // Split line by line.
                    // Theoretically, splitting here won't break json in middle, as newlines are escaped
                    // So all split results are complete data: lines
                    // But considering network transmission, data: might be cut in middle, so safest method is buffer caching. TODO
                    // console.info(`chunk_line = ${data_line}`)
                    const trimmedLine = data_line.trim();
                    // Ignore empty or invalid lines
                    if (!trimmedLine || !trimmedLine.startsWith('data:')) {
                        continue;
                    }
                    // Process "data:" prefix
                    const jsonString = trimmedLine.replace(/^data:/, ''); // Remove "data:" prefix
                    // Special case: handle stream end flag "data: [DONE]"
                    if (jsonString.trim() === '[DONE]') {
                        console.info('Got [DONE]. Stream finished.');
                        is_stream_done = true;
                        break;
                    }
                    try {
                        // Parse JSON data
                        const str_json_parsed = JSON.parse(jsonString);
                        const parsed = str_json_parsed; // Keep both names for transition
                        //
                        let new_delta = str_json_parsed.choices[0]?.delta || {};
                        let finish_reason = str_json_parsed.choices[0]?.finish_reason || null
                        //
                        // If type not yet determined
                        if (reply_type == 'unknown') {
                            // Tool call
                            if (finish_reason == null) {
                                if ('tool_calls' in new_delta) { // Criterion: if this key exists
                                    reply_type = 'tool_calls';
                                }
                            }
                            else if (finish_reason == 'tool_calls') {
                                reply_type = 'tool_calls';
                            }
                            else {
                                // Regular
                                reply_type = 'content';
                                // await print_head();
                                // cursor_pos = await get_cursor_pos();
                            }
                        }
                        // console.info('[875] new_delta = ', new_delta)
                        // console.info('[876] reply_type = ', reply_type);
                        //
                        // Save received content
                        if ('tool_calls' in new_delta) {
                            console.info('[1016] new_delta = ', new_delta)
                            for (let delta_tool_calls of new_delta['tool_calls']) {
                                lst_tool_calls.push(delta_tool_calls);
                            }
                        }
                        //}
                        else { //if (reply_type == 'content') {  // If text reply (usually)
                            // Process content
                            let delta_content = parsed.choices[0]?.delta?.content || '';
                            //
                            if (['<think>', '<THINK>'].indexOf(delta_content.trim()) !== -1) {
                                thinking_status = 'thinking'
                                // 
                                // Visualize waiting during thinking
                                if (hide_thinking) {
                                    await on_think_start();
                                    continue;
                                }
                            }
                        }
                    else if (thinking_status === 'thinking') {  // If already thinking
                            if (['</think>', '</THINK>'].indexOf(delta_content.trim()) !== -1) {  // End thinking marker
                                thinking_status = 'think_ends';
                                await on_think_end();
                            }
                            if (hide_thinking) {
                                continue;
                            }
                        }
                        else if (thinking_status === 'think_ends') {
                            if (delta_content.trim() === '') {
                                if (hide_thinking) {
                                    continue;
                                }
                            }
                            else if (delta_content.trim().length > 0) {
                                thinking_status = 'think_finished';
                                await on_think_end();
                                if (hide_thinking) {
                                    delta_content = delta_content.trim();
                                }
                            }
                        }
                        //
                        if (thinking_status === 'think_finished') {
                            // Avoid LLM outputting head again. This logic is outdated, may consider removing later
                            if (need_add_head) {
                                if (output_str.length > 10 && !output_str.trim().startsWith('**')) {  // Definitely not duplicate
                                    await insert_content_move_view(output_str);
                                    flag_head_to_write = false;
                                }
                                else if (output_str.length > (5 + `**${CHAT_HEAD}**`.length)) {
                                    if (output_str.trim().startsWith(`**${CHAT_HEAD}**`)) {  //
                                        output_str = output_str.replace(`**${CHAT_HEAD}**`, ''); // Avoid duplicate
                                        await insert_content_move_view(output_str);
                                    }
                                    else {
                                        await insert_content_move_view(output_str);
                                    }
                                    flag_head_to_write = false;
                                }
                                fail_count = 0;
                            }
                            else { // if (reply_type == 'content') {
                                if (hide_thinking) {
                                    let delta_content_result = response_split_stream(delta_content);
                                    await insert_content_move_view(delta_content_result);
                                }
                                else {
                                    await insert_content_move_view(delta_content); // Update content in real-time
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                console.warn('Failed to parse line:', trimmedLine, err);
                fail_count += 1;
            }
        }
    }
    else {
        console.info('Chunk is not string: ', chunk);
    }
}
//
// LLM reply complete, execute cleanup work ================= ================ ===============
//
if (reply_type == 'content') { // Cleanup type: text reply mode
    try {
        // In case total length insufficient so above didn't execute;
        if (need_add_head) {
            await insert_content_move_view(output_str);
        }
        // Prevent LLM from going crazy and outputting manually set ending again.
        if (output_str.trim().endsWith(CHAT_TAIL)) {
            await insert_content_move_view('\n\n');
            flags.tail_printed = true;
        }
        else {  // Normal case, program outputs ending
            await print_tail();
            flags.tail_printed = true;
        }
        //
        // Display completion message
        // await joplin.commands.execute('editor.execCommand', {
        //     name: 'cm-tempFloatingObject',
        //     args: [{ 
        //         text: `Finished.`, 
        //         floatId: get_random_floatid(), 
        //         ms: 2000, 
        //         bgColor: COLOR_FLOAT.FINISH
        //     }]
        // });
        await add_short_floating(
            `Finished.`,
            get_random_floatid(),
            2000,
            COLOR_FLOAT.FINISH
        );
    }
    catch (err) {
        console.error('ERR501_in_utils.ts: ', err);
    }
}
//
else if (reply_type == 'tool_calls') {  // Cleanup type: tool call mode
    //
    console.log('[1180] lst_tool_calls = ', lst_tool_calls);
    //
    // Stream may get incomplete request, need to concatenate:
    let lst_tool_call_quests = [];
    for (const toolCallDelta of lst_tool_calls) {
        const index = toolCallDelta.index;

        // If first chunk for this index, initialize assembler
        if (!lst_tool_call_quests[index]) {
            lst_tool_call_quests[index] = { id: "", type: "function", function: { name: "", arguments: "" } };
        }

        // Concatenate ID
        if (toolCallDelta.id) {
            lst_tool_call_quests[index].id += toolCallDelta.id;
        }
        // Concatenate function name
        if (toolCallDelta.function?.name) {
            lst_tool_call_quests[index].function.name += toolCallDelta.function.name;
        }
        // Concatenate arguments (most critical part)
        if (toolCallDelta.function?.arguments) {
            lst_tool_call_quests[index].function.arguments += toolCallDelta.function.arguments;
        }
    }
    // After concatenation complete
    console.log('[1206] lst_tool_call_quests = ', lst_tool_call_quests);
    //
    // Call tool via post request
    let lst_tool_result = []
    let lst_tool_result_message = []  // 
    let tool_name_cache = '';
    for (const tool_call_one of lst_tool_call_quests) {
        let tool_result_one: any;  // Execution result
        tool_name_cache = tool_call_one.function.name;
        let tool_call_id: string = tool_call_one['id'];
        try {
            let tool_call_name = ''
            let json_body: string;
            //
            // Display toast
            if (MCP_MODE == 'agent') {
                tool_call_name = 'call_agents';  // Actually can omit, but some models aren't smart enough, force specify to avoid errors
                // if ("agent_id" in tool_call_one.function.arguments){
                //     console.log(tool_call_one.function.arguments)
                // }
                // else {
                //     throw new Error('Key parameter missing');
                // }
                try {
                    let agent_name = tool_call_one.function.arguments
                    await on_tool_call_start(agent_name);
                }
                catch (e) {
                    console.log(`Line 761: ${e}`)
                }
            }
            else { // normal mode
                tool_call_name = tool_call_one.function.name
                await on_tool_call_start(tool_call_name);
            }
            //
            // Execute tool call
            if (false) {
                let MCP_RUN_URL = '';
                MCP_RUN_URL = MCP_SERVER + '/mcp/call_tool'
                json_body = JSON.stringify({
                    name: tool_call_name,
                    arguments: tool_call_one.function.arguments
                })
                console.log("json_body =", json_body)
                const tool_call_response = await fetch(MCP_RUN_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: json_body
                });

                if (!tool_call_response.ok) {
                    throw new Error('Network response abnormal');
                }

                tool_result_one = await tool_call_response.json();
            }
            else {
                // let mcp_url = MCP_SERVER
                let tool_call_args_json = tool_call_one.function.arguments
                let tool_call_args = JSON.parse(tool_call_args_json)
                let tool_real_name = openai_map[tool_call_name]['function_name']
                let tool_real_server_url = openai_map[tool_call_name]['server_url']
                let tool_headers = openai_map[tool_call_name]['headers'] || ''
                //
                console.log(`tool_real_server_url = ${tool_real_server_url}, tool_call_name = ${tool_call_name}, tool_real_name = ${tool_real_name}`)
                console.log('tool_call_args = ', tool_call_args)
                console.log('len = ', Object.keys(tool_call_args).length)
                let result_one: any;
                if (Object.keys(tool_call_args).length > 0) {
                    result_one = await mcp_call_tool(
                        tool_real_server_url,
                        tool_real_name, //'get_date_diff',
                        tool_call_args, //{date_from:'2025-01-01',date_to:'2025-01-10'}
                        tool_headers
                    )
                }
                else {
                    result_one = await mcp_call_tool(
                        tool_real_server_url,
                        tool_real_name, //'get_date_diff',
                        {},
                        tool_headers
                    )
                }
                console.log('[Line 934] result_one = ', result_one)  // TODO still need to handle error cases
                if (Array.isArray(result_one)) {
                    tool_result_one = result_one[0].result.content[0].text
                }
                else {
                    tool_result_one = result_one.result.content[0].text
                }
                tool_result_one = `<name>${tool_call_name}</name>\n<args>${tool_call_args_json}</args>\n<result>${tool_result_one}</result>`
            }
            //
            // Save response result to variable a
            console.log('Request successful:', tool_result_one);
            lst_tool_result.push(tool_result_one);
            lst_tool_result_message.push({
                'role': 'tool',
                'tool_call_id': tool_call_id,
                "content": tool_result_one
            });
            //
            if (MCP_MODE == 'agent') {
                round_tool_call = MAX_TOOL_CALL_ROUND + 1;  // After agent success, don't call others
            }
        }
        catch (error) {
            console.error('Request failed:', error);
        }
        finally {
            await on_tool_call_end(tool_call_one);
        }
    }
    console.log(`lst_tool_result = ${lst_tool_result}`)  // Working normally
    console.log(`lst_tool_result.length = ${lst_tool_result.length}`)  // Working normally
    console.log(`Type of lst_tool_result[0] is: ${typeof lst_tool_result[0]}`);

    //
    // Re-run to get LLM response
    console.log(`tool_name_cache = ${tool_name_cache}`);
    //
    if (tool_name_cache == 'get_tool_groups') {  // get_tool_groups is specifically for getting tool group details
        let second_list_tool = []
        try {
            // console.log(`lst_tool_result[0] = `,lst_tool_result[0])
            // console.log(`lst_tool_result[0]['result'] = `,lst_tool_result[0]['result'])
            second_list_tool = JSON.parse(lst_tool_result[0])['result']['tools']
        }
        catch (e) {
            console.log(`lst_tool_result['result'] = `, lst_tool_result['result'])
            second_list_tool = lst_tool_result['result']['tools']
        }
        //
        await llmReplyStream({
            inp_str: 'null',
            lst_msg: prompt_messages,
            round_tool_call: round_tool_call + 1,
            lst_tools_input: second_list_tool,
            flags: flags
        });
    }
    else {  // Normal tool call, actually executing functionality
        let prompt_messages_with_tool_result = [
            ...prompt_messages,
            { 'role': 'user', 'content': `<tool_result> ${lst_tool_result} </tool_result>` }
        ];
        //
        console.log('[1368] prompt_messages_with_tool_result = ', prompt_messages_with_tool_result);
        //
        await llmReplyStream({
            inp_str: 'null',
            lst_msg: prompt_messages_with_tool_result,
            round_tool_call: round_tool_call + 1,
            flags: flags
        });
    }
}
// Tail output
if (flags.tail_printed) {
    // Tail already printed, don't print again
}
else {
    if (result_whole.trim().length > 0) {
        await print_tail();
        flags.tail_printed = true;
    }
}
        }
        // If output parsing failed
        catch (err) {
    console.error('ERR531_in_utils.ts: ', err);
}
// Cleanup work to execute whether success or failure
finally {
    try {
        await on_wait_end();
    }
    catch (err) {
        //
    }
    //
    try {
        await on_think_end();
    }
    catch {
        //
    }
    await on_before_return();
}
    }
}

/**
 * Manual stop
 */
export async function llmReplyStop() {
    //
    const locale = await joplin.settings.globalValue('locale');
    let dictText = await get_txt_by_locale();
    // flags
    let llmSettingFlags = await joplin.settings.values(['llmFlagLlmRunning'])
    let is_running = parseInt(String(llmSettingFlags['llmFlagLlmRunning']));
    //
    if (is_running == 1) { // Running, force stop
        await joplin.settings.setValue('llmFlagLlmRunning', 0);
        // alert('Force stopped!')
        // await joplin.commands.execute('editor.execCommand', {
        //     name: 'cm-tempFloatingObject',
        //     args: [{ text: `NoteLLM force stoped!`, 
        //         floatId: 'llm_stop_1', ms: 3000, bgColor: COLOR_FLOAT.WARNING }]
        // });
        await add_short_floating(
            `NoteLLM force stoped!`,
            get_random_floatid(),
            3000,
            COLOR_FLOAT.WARNING
        );
        return;
    }
    else { // Not running
        // await joplin.commands.execute('editor.execCommand', {
        //     name: 'cm-tempFloatingObject',
        //     args: [{ text: `NoteLLM stoped.`, 
        //         floatId: 'llm_stop_0', ms: 3000, bgColor: COLOR_FLOAT.FINISH }]
        // });
        await add_short_floating(
            `NoteLLM stoped.`,
            get_random_floatid(),
            3000,
            COLOR_FLOAT.FINISH
        );
    }
}

/**
 * Switch LLM model option
 * @param llm_no Number representing the model index to use
 */
export async function changeLLM(llm_no = 0) {
    let int_target_llm = 0;
    if (llm_no != 0) {
        int_target_llm = llm_no;
    }
    else {
        let current_llm = await joplin.settings.values(['llmSelect']);
        let int_current_llm = parseInt(String(current_llm['llmSelect']));
        if (int_current_llm == 1) {
            int_target_llm = 2
        }
        else if (int_current_llm == 3) {
            int_target_llm = 3
        }
        else {
            int_target_llm = 1
        }
    }
    console.log(int_target_llm);
    //
    // toast for LLM changing
    //
    await joplin.settings.setValue('llmSelect', int_target_llm);
    //
    const dict_llm = await get_llm_options();
    const apiModel = dict_llm['model'];
    //
    await add_short_floating(
        `LLM ${int_target_llm} (${apiModel}) selected!`,
        get_random_floatid(),
        3000,
        COLOR_FLOAT.SETTING
    );
    //
    // test llm connection
    let TEST_LLM_CONNECTION = true;
    if (TEST_LLM_CONNECTION) {
        await check_llm_status(false);
    }
}

export async function check_llm_status(show_ok = true) {
    let test_result = 'OK';
    let apiModel = '';
    //
    try {
        // Use unified parameter reading function
        const dict_llm = await get_llm_options();

        // Extract parameters
        apiModel = dict_llm['model'];
        const apiUrl = dict_llm['url'];
        const apiKey = dict_llm['key'];
        const int_target_llm = dict_llm['llmSelect'];

        // If key parameters missing, report error directly without proceeding
        if (apiModel.trim() === '') {
            test_result = 'Model Name is Empty?';
        }
        else if (apiUrl.trim() === '') {
            test_result = 'Model URL is Empty?';
        }
        else if (apiKey.trim() === '') {
            test_result = 'Model Key is Empty?';
        }
        else {
            // Test connection
            try {
                // let check = await testChatCompletion(apiUrl, apiKey, apiModel);
                let check = await testListModels(apiUrl, apiKey);
                if (check.available) {
                    test_result = 'OK'
                }
                else {
                    test_result = check.error;
                }
            } catch {
                test_result = 'Connection_Error';
            }
        }

        if (test_result == 'OK') {
            if (show_ok) {
                await add_short_floating(
                    `LLM ${int_target_llm} Status: OK (Model = ${apiModel}) `,
                    get_random_floatid(),
                    3000,
                    COLOR_FLOAT.FINISH
                );
            }
        }
        else {
            await add_short_floating(
                `LLM ${int_target_llm} Error: ${test_result} (Model = ${apiModel}) `,
                get_random_floatid(),
                4000,
                COLOR_FLOAT.WARNING
            );
        }
    }
    catch (err) {
        console.error('Error in check_llm_status:', err);
        await add_short_floating(
            `LLM (Model = ${apiModel}) Server Connection Error: ${err}`,
            get_random_floatid(),
            4000,
            COLOR_FLOAT.WARNING
        );
    }
}

async function testListModels(baseURL: string, apiKey: string) {
    try {
        let fixedURL = baseURL.replace("/chat/completions", '/models')
        const response = await fetch(`${fixedURL}`, {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (response.ok) {
            const data = await response.json();
            return {
                available: true,
                response: data.choices?.[0]?.message?.content || 'OK',
                usage: data.usage
            };
        }
        else {
            const errorData = await response.json().catch(() => ({}));
            return {
                available: false,
                error: errorData.error?.message || `HTTP ${response.status}`,
                status: response.status
            };
        }
    }
    catch (error) {
        return {
            available: false,
            error: error.message
        };
    }
};

async function testChatCompletion(baseURL: string, apiKey: string, model: string) {
    try {
        const response = await fetch(`${baseURL}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model,
                messages: [{ role: 'user', content: 'Hi' }],
                max_tokens: 5
            })
        });
        if (response.ok) {
            const data = await response.json();
            return {
                available: true,
                response: data.choices?.[0]?.message?.content || 'OK',
                usage: data.usage
            };
        }
        else {
            const errorData = await response.json().catch(() => ({}));
            return {
                available: false,
                error: errorData.error?.message || `HTTP ${response.status}`,
                status: response.status
            };
        }
    }
    catch (error) {
        return {
            available: false,
            error: error.message
        };
    }
}

async function mcp_get_tools_restful(MCP_SERVER_URL_RESTFUL: string) {
    let openai_tools = await fetch(MCP_SERVER_URL_RESTFUL)
        .then(mcp_response => {
            if (!mcp_response.ok) {
                throw new Error('MCP_网络响应失败');
            }
            return mcp_response.json(); // 如果返回的是 JSON 数据
        })
        .then(data => {
            console.log('MCP_获取到的数据:', data); // 处理返回的数据
            return data;
        })
        .catch(error => {
            console.error('MCP_请求失败:', error);  // 服务器未启动，或者连接错误等，都会走到这里
            // 可以添加 on_mcp_error 函数
            return { 'tools': [] }  // 
        });
    return openai_tools;
}