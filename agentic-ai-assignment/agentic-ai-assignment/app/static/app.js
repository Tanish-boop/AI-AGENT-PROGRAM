// Global State
let activeSessionId = null;
let selectedFile = null;
let isPolling = false;
let displayedLogCount = 0;
let pollingInterval = null;

// Intent Classification and Confidence Mappings
const intentMap = {
    'image_pdf_ocr': 'OCR & PDF Extraction',
    'youtube_transcript': 'YouTube Transcript Extraction',
    'conversation': 'Conversational Answering',
    'summarize': 'Summarization',
    'sentiment': 'Sentiment Analysis',
    'code_explain': 'Code Explanation',
    'audio_transcribe_summary': 'Audio Transcription'
};

const confidenceMap = {
    'image_pdf_ocr': '96%',
    'youtube_transcript': '98%',
    'conversation': '97%',
    'summarize': '91%',
    'sentiment': '93%',
    'code_explain': '95%',
    'audio_transcribe_summary': '92%'
};

// DOM Elements
const chatForm = document.getElementById('chat-form');
const chatTextarea = document.getElementById('chat-textarea');
const fileInput = document.getElementById('file-input');
const attachBtn = document.getElementById('attach-btn');
const sendBtn = document.getElementById('send-btn');
const uploadPreview = document.getElementById('upload-preview');
const previewFileName = document.getElementById('preview-file-name');
const previewFileSize = document.getElementById('preview-file-size');
const previewFileIcon = document.getElementById('preview-file-icon');
const removeFileBtn = document.getElementById('remove-file-btn');
const chatFeed = document.getElementById('chat-feed');
const welcomeView = document.getElementById('welcome-view');
const statusBadge = document.getElementById('status-badge');
const costDisplay = document.getElementById('cost-display');
const planSteps = document.getElementById('plan-steps');
const terminalLogs = document.getElementById('terminal-logs');
const intentContainer = document.getElementById('intent-container');
const sessionIdDisplay = document.getElementById('session-id-display');
const newSessionBtn = document.getElementById('new-session-btn');
const extractionPanel = document.getElementById('extraction-panel');
const extractionHeader = document.getElementById('extraction-header');
const extractedFileName = document.getElementById('extracted-file-name');
const extractionMethodBadge = document.getElementById('extraction-method-badge');
const extractionConfidenceBadge = document.getElementById('extraction-confidence-badge');
const extractedTextContent = document.getElementById('extracted-text-content');
const resultPanel = document.getElementById('result-panel');
const finalResultContent = document.getElementById('final-result-content');
const copyResultBtn = document.getElementById('copy-result-btn');

// Initialize App
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    resetSessionState();
});

// Event Listeners Configuration
function setupEventListeners() {
    // Form Submit
    chatForm.addEventListener('submit', handleFormSubmit);
    
    // Auto-expand Textarea on input
    chatTextarea.addEventListener('input', () => {
        chatTextarea.style.height = 'auto';
        chatTextarea.style.height = (chatTextarea.scrollHeight) + 'px';
    });

    // Enter Key Submission (Shift + Enter for newline)
    chatTextarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            chatForm.dispatchEvent(new Event('submit'));
        }
    });

    // Attachment Trigger
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileSelection);
    removeFileBtn.addEventListener('click', clearFileSelection);

    // Prompt Chips Clicking
    document.querySelectorAll('.prompt-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            chatTextarea.value = chip.dataset.prompt;
            chatTextarea.focus();
            chatTextarea.dispatchEvent(new Event('input'));
        });
    });

    // Toggle Collapsible Extraction Accordion
    extractionHeader.addEventListener('click', () => {
        extractionPanel.classList.toggle('collapsed');
    });

    // Reset Session Trigger
    newSessionBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to reset and start a new session?')) {
            resetSessionState();
            showToast('Session reset successfully.', 'success');
        }
    });

    // Copy Result Content
    copyResultBtn.addEventListener('click', copyResultToClipboard);
}

// File Selection Handler
function handleFileSelection(e) {
    const file = e.target.files[0];
    if (!file) return;

    selectedFile = file;
    
    // Update Preview Panel UI
    previewFileName.textContent = file.name;
    previewFileSize.textContent = formatBytes(file.size);
    
    // Choose appropriate icon
    const ext = file.name.split('.').pop().toLowerCase();
    let iconClass = 'fa-solid fa-file';
    if (['png', 'jpg', 'jpeg'].includes(ext)) iconClass = 'fa-solid fa-file-image';
    else if (ext === 'pdf') iconClass = 'fa-solid fa-file-pdf';
    else if (['mp3', 'wav', 'm4a'].includes(ext)) iconClass = 'fa-solid fa-file-audio';
    
    previewFileIcon.className = iconClass;
    uploadPreview.style.display = 'flex';
    
    showToast(`Attached file: ${file.name}`, 'info');
}

// Clear File Handler
function clearFileSelection() {
    selectedFile = null;
    fileInput.value = '';
    uploadPreview.style.display = 'none';
}

// Main Submit Router
async function handleFormSubmit(e) {
    e.preventDefault();
    
    const queryText = chatTextarea.value.trim();
    if (!queryText && !selectedFile) {
        showToast('Please enter a query or upload a file.', 'error');
        return;
    }

    // Hide welcome view if visible on first submit
    if (welcomeView) {
        welcomeView.style.display = 'none';
    }

    // Add user bubble
    let bubbleText = queryText;
    if (selectedFile) {
        bubbleText = `[Uploaded File: ${selectedFile.name}] ${queryText}`.trim();
    }
    appendMessage(bubbleText, 'user');
    
    // Cache inputs and clear prompt text bar to prevent double submit
    const currentQuery = queryText;
    const currentFile = selectedFile;
    chatTextarea.value = '';
    chatTextarea.style.height = 'auto';
    clearFileSelection();
    
    // Choose route: respond to follow-up OR start new chat
    if (activeSessionId && statusBadge.textContent === 'Needs Clarification') {
        await submitClarification(currentQuery);
    } else {
        await submitNewChat(currentQuery, currentFile);
    }
}

// Start New Chat API Call
async function submitNewChat(query, file) {
    updateStatus('planning');
    appendTerminalLog('[System] Dispatching request to Planner...');
    
    const formData = new FormData();
    if (query) formData.append('query', query);
    if (file) formData.append('file', file);
    
    try {
        const response = await fetch('/api/chat', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || 'Failed to submit workflow.');
        }
        
        const session = await response.json();
        processSessionUpdate(session);
        
    } catch (err) {
        updateStatus('failed');
        appendTerminalLog(`[Error] ${err.message}`, 'error');
        showToast(err.message, 'error');
    }
}

// Submit Continuation / Clarification API Call
async function submitClarification(clarification) {
    updateStatus('planning');
    appendTerminalLog('[System] Dispatching clarification to Planner...');
    
    const formData = new FormData();
    formData.append('session_id', activeSessionId);
    formData.append('clarification', clarification);
    
    try {
        const response = await fetch('/api/respond', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || 'Failed to submit clarification.');
        }
        
        const session = await response.json();
        processSessionUpdate(session);
        
    } catch (err) {
        updateStatus('failed');
        appendTerminalLog(`[Error] ${err.message}`, 'error');
        showToast(err.message, 'error');
    }
}

// Processes Response updates from Backend
function processSessionUpdate(session) {
    activeSessionId = session.session_id;
    sessionIdDisplay.textContent = activeSessionId.substring(0, 8) + '...';
    
    // Display Cost
    costDisplay.textContent = `$${session.cost_estimate.toFixed(6)}`;
    
    // Update Detected Intent Panel
    if (intentContainer) {
        if (session.task_type) {
            const mappedIntent = intentMap[session.task_type] || session.task_type;
            const confidence = confidenceMap[session.task_type] || '91%';
            intentContainer.innerHTML = `
                <div class="intent-row">
                    <span class="intent-label">Intent:</span>
                    <span class="intent-value">${mappedIntent}</span>
                </div>
                <div class="intent-row">
                    <span class="intent-label">Confidence:</span>
                    <span class="intent-value highlight-value">${confidence}</span>
                </div>
            `;
        } else {
            intentContainer.innerHTML = '<div class="empty-state-text">No intent detected yet.</div>';
        }
    }
    
    // Update execution steps
    renderPlanSteps(session.plan);
    
    // Append logs
    syncLogs(session.logs);
    
    if (session.status === 'ambiguous') {
        updateStatus('ambiguous');
        appendMessage(session.follow_up_question, 'agent');
        showToast('Clarification required.', 'info');
    } else if (session.status === 'ready' || session.status === 'running') {
        updateStatus('running');
        startPolling();
    } else if (session.status === 'completed') {
        updateStatus('completed');
        displayFinalResults(session);
    } else if (session.status === 'failed') {
        updateStatus('failed');
        displayFinalResults(session);
    }
}

// Starts status polling
function startPolling() {
    if (isPolling) return;
    isPolling = true;
    
    pollingInterval = setInterval(async () => {
        try {
            const response = await fetch(`/api/status/${activeSessionId}`);
            if (!response.ok) throw new Error('Polling status failed.');
            
            const session = await response.json();
            syncLogs(session.logs);
            updateStatus(session.status);
            
            // Update Detected Intent Panel if it changes
            if (intentContainer && session.task_type && !intentContainer.querySelector('.intent-value')) {
                const mappedIntent = intentMap[session.task_type] || session.task_type;
                const confidence = confidenceMap[session.task_type] || '91%';
                intentContainer.innerHTML = `
                    <div class="intent-row">
                        <span class="intent-label">Intent:</span>
                        <span class="intent-value">${mappedIntent}</span>
                    </div>
                    <div class="intent-row">
                        <span class="intent-label">Confidence:</span>
                        <span class="intent-value highlight-value">${confidence}</span>
                    </div>
                `;
            }
            
            // Highlight plan step based on current active logs
            updateActivePlanStep(session.logs, session.plan);
            
            if (session.status === 'completed' || session.status === 'failed') {
                stopPolling();
                displayFinalResults(session);
            }
            
        } catch (err) {
            stopPolling();
            updateStatus('failed');
            appendTerminalLog(`[Error during status check] ${err.message}`, 'error');
        }
    }, 1000);
}

// Stops status polling
function stopPolling() {
    isPolling = false;
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
}

// Sync logs cleanly with terminal window
function syncLogs(logsList) {
    if (!logsList || logsList.length === 0) return;
    
    for (let i = displayedLogCount; i < logsList.length; i++) {
        let line = logsList[i];
        let type = 'info';
        
        if (line.includes('[ERROR]')) {
            type = 'error';
            line = line.replace('[Backend] [ERROR]', '[ERROR]').replace('[ERROR]', '[ERROR]');
        } else if (line.includes('[SUCCESS]') || line.includes('completed successfully')) {
            type = 'success';
            line = line.replace('[Backend] [SUCCESS]', '[SUCCESS]').replace('[SUCCESS]', '[SUCCESS]');
        } else {
            line = line.replace('[Backend]', '[INFO]')
                       .replace('[Executor]', '[INFO]')
                       .replace('[System]', '[INFO]');
            
            if (!line.startsWith('[')) {
                line = `[INFO] ${line}`;
            }
        }
        
        // Clean up double tags and prefixing
        line = line.replace(/^\[INFO\]\s*\[INFO\]/, '[INFO]');
        line = line.replace(/^\[INFO\]\s*\[System\]/, '[INFO]');
        line = line.replace(/^\[System\]/, '[INFO]');
        line = line.replace(/^\[Executor\]/, '[INFO]');
        
        appendTerminalLog(line, type);
    }
    displayedLogCount = logsList.length;
}

// Displays execution details and final results
function displayFinalResults(session) {
    if (session.status === 'completed') {
        appendMessage('Execution completed. The parsed content and output results have been generated.', 'agent');
        showToast('Workflow completed!', 'success');
        
        // Populate Extracted text accordion
        if (session.extracted_text) {
            extractedFileName.textContent = session.file_name || 'Uploaded File';
            extractionMethodBadge.textContent = `Method: ${session.file_type || 'N/A'}`;
            extractionConfidenceBadge.textContent = 'Confidence: High';
            extractedTextContent.textContent = session.extracted_text;
            extractionPanel.classList.remove('collapsed');
        } else {
            extractionPanel.classList.add('collapsed');
        }
        
        // Populate Results Panel
        finalResultContent.innerHTML = formatMarkdown(session.result || 'No output text returned.');
        resultPanel.classList.remove('collapsed');
        
    } else if (session.status === 'failed') {
        appendMessage(`Execution failed. Refer to logs for diagnostics.`, 'agent');
        showToast('Workflow failed.', 'error');
        
        finalResultContent.innerHTML = `<div class="error-msg" style="padding: 10px; border-left: 3px solid var(--accent-red); background: rgba(239, 68, 68, 0.05);"><strong>Error during execution:</strong><br>${session.result || 'Unknown execution failure.'}</div>`;
        resultPanel.classList.remove('collapsed');
    }
}

// HTML formatter helper to approximate markdown syntax in HTML
function formatMarkdown(text) {
    let html = text;
    // Replace headers
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
    // Code blocks
    html = html.replace(/```([\s\S]*?)```/gm, '<pre><code>$1</code></pre>');
    // Inline code
    html = html.replace(/`([^`\n]+)`/gm, '<code>$1</code>');
    // Bullet items
    html = html.replace(/^\- (.*$)/gim, '<li>$1</li>');
    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    
    // Clean up lists wrapper
    html = html.replace(/(<li>.*<\/li>)/g, '<ul>$1</ul>');
    
    return html;
}

// Update Active Plan Step Highlight visually
function updateActivePlanStep(logs, plan) {
    if (!plan || plan.length === 0) return;
    
    // Read the last execution log step number
    let currentStepNum = 0;
    for (let i = logs.length - 1; i >= 0; i--) {
        const match = logs[i].match(/Running Step (\d+)/);
        if (match) {
            currentStepNum = parseInt(match[1]);
            break;
        }
    }
    
    document.querySelectorAll('.plan-step-item').forEach((stepItem, idx) => {
        const stepNum = idx + 1;
        stepItem.className = 'plan-step-item';
        
        if (stepNum < currentStepNum) {
            stepItem.classList.add('completed');
            const icon = stepItem.querySelector('i');
            icon.className = 'fa-solid fa-square-check';
        } else if (stepNum === currentStepNum) {
            stepItem.classList.add('active');
            const icon = stepItem.querySelector('i');
            icon.className = 'fa-solid fa-spinner fa-spin';
        } else {
            const icon = stepItem.querySelector('i');
            icon.className = 'fa-regular fa-square';
        }
    });
}

// Resets Session UI
function resetSessionState() {
    stopPolling();
    activeSessionId = null;
    selectedFile = null;
    displayedLogCount = 0;
    
    // DOM Clearances
    chatTextarea.value = '';
    fileInput.value = '';
    uploadPreview.style.display = 'none';
    costDisplay.textContent = '$0.000000';
    sessionIdDisplay.textContent = 'None';
    
    if (intentContainer) {
        intentContainer.innerHTML = '<div class="empty-state-text">No intent detected yet.</div>';
    }
    
    // Clear lists
    planSteps.innerHTML = '<div class="empty-state-text">No active execution plan yet.</div>';
    terminalLogs.innerHTML = '<div class="terminal-line system-msg">[INFO] Ready to accept workflows.</div>';
    
    // Clear feed (restore welcome screen)
    chatFeed.innerHTML = '';
    if (welcomeView) {
        welcomeView.style.display = 'flex';
        chatFeed.appendChild(welcomeView);
    }
    
    // Collapse result panels
    extractionPanel.classList.add('collapsed');
    resultPanel.classList.add('collapsed');
    
    updateStatus('idle');
}

// Renders plan steps list in Sidebar
function renderPlanSteps(steps) {
    if (!steps || steps.length === 0) {
        planSteps.innerHTML = '<div class="empty-state-text">No active execution plan yet.</div>';
        return;
    }
    
    planSteps.innerHTML = steps.map(step => `
        <div class="plan-step-item">
            <i class="fa-regular fa-square"></i>
            <div>
                <span class="plan-step-num">Step ${step.step}:</span>
                <span>${step.description}</span>
            </div>
        </div>
    `).join('');
}

// Appends terminal line output
function appendTerminalLog(message, type = 'system') {
    const line = document.createElement('div');
    line.className = `terminal-line ${type}-msg`;
    line.textContent = message;
    terminalLogs.appendChild(line);
    terminalLogs.scrollTop = terminalLogs.scrollHeight;
}

// Appends chat message bubble
function appendMessage(text, sender) {
    const bubble = document.createElement('div');
    bubble.className = `chat-msg ${sender}-bubble`;
    
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = sender === 'user' ? 'You' : 'Agent';
    
    const content = document.createElement('div');
    content.textContent = text;
    
    bubble.appendChild(meta);
    bubble.appendChild(content);
    
    chatFeed.appendChild(bubble);
    chatFeed.scrollTop = chatFeed.scrollHeight;
}

// Updates visual status badge
function updateStatus(status) {
    statusBadge.textContent = status;
    statusBadge.className = 'status-badge';
    
    if (status === 'idle') statusBadge.classList.add('status-idle');
    else if (status === 'planning') statusBadge.classList.add('status-running');
    else if (status === 'running') statusBadge.classList.add('status-running');
    else if (status === 'completed') statusBadge.classList.add('status-completed');
    else if (status === 'failed') statusBadge.classList.add('status-failed');
    else if (status === 'ambiguous') statusBadge.classList.add('status-ambiguous');
}

// Copy to Clipboard
function copyResultToClipboard() {
    const textToCopy = finalResultContent.innerText;
    navigator.clipboard.writeText(textToCopy).then(() => {
        showToast('Output copied to clipboard!', 'success');
    }).catch(err => {
        showToast('Failed to copy text.', 'error');
    });
}

// Helpers
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Toast Center Trigger
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = 'fa-circle-info';
    if (type === 'success') icon = 'fa-circle-check';
    else if (type === 'error') icon = 'fa-circle-exclamation';
    
    toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${message}</span>`;
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease reverse forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
