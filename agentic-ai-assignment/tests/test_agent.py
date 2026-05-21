import os
import json
import pytest
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient

# Mock GEMINI_API_KEY for tests
os.environ["GEMINI_API_KEY"] = "mock_key_for_testing"

from app.main import app
from app.agent.state import create_session, get_session, update_session
from app.agent.tasks import extract_youtube_video_id
from app.agent.planner import plan_task, estimate_cost
from app.agent.executor import execute_plan

client = TestClient(app)

def test_session_state():
    """Verifies SessionState operations."""
    session = create_session()
    assert session.session_id is not None
    assert session.status == "created"
    
    updated = update_session(session.session_id, status="running", task_type="summarize")
    assert updated.status == "running"
    assert updated.task_type == "summarize"
    
    retrieved = get_session(session.session_id)
    assert retrieved.session_id == session.session_id
    assert retrieved.task_type == "summarize"

def test_youtube_video_id_extraction():
    """Verifies URL parsing logic for YouTube videos."""
    urls = [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "http://youtube.com/watch?v=dQw4w9WgXcQ&feature=related",
        "https://youtu.be/dQw4w9WgXcQ",
        "youtube.com/embed/dQw4w9WgXcQ",
        "Here is a video: https://www.youtube.com/watch?v=dQw4w9WgXcQ and it is cool."
    ]
    for url in urls:
        assert extract_youtube_video_id(url) == "dQw4w9WgXcQ"
        
    invalid_url = "https://google.com/watch?v=dQw4w9WgXcQ"
    assert extract_youtube_video_id(invalid_url) is None

@patch("google.genai.Client")
def test_planner_ambiguity(mock_client_class):
    """Verifies that vague queries trigger follow-up questions."""
    mock_client = MagicMock()
    mock_client_class.return_value = mock_client
    
    # Configure mock response for ambiguity
    mock_response = MagicMock()
    mock_response.text = json.dumps({
        "is_ambiguous": True,
        "follow_up_question": "What would you like me to do with this file?",
        "task_type": None,
        "plan_steps": [],
        "reasoning": "No query instructions provided with the document."
    })
    mock_client.models.generate_content.return_value = mock_response
    
    result = plan_task(query="", extracted_text="Some text content", file_type="pdf")
    
    assert result["status"] == "ambiguous"
    assert result["follow_up_question"] == "What would you like me to do with this file?"
    assert result["task_type"] is None
    assert len(result["plan"]) == 0

@patch("google.genai.Client")
def test_planner_ready_intent(mock_client_class):
    """Verifies that clear queries draft plans and identify tasks."""
    mock_client = MagicMock()
    mock_client_class.return_value = mock_client
    
    mock_response = MagicMock()
    mock_response.text = json.dumps({
        "is_ambiguous": False,
        "follow_up_question": None,
        "task_type": "summarize",
        "plan_steps": ["Read source text", "Generate 3-part summary format"],
        "reasoning": "User explicitly asked to summarize the document."
    })
    mock_client.models.generate_content.return_value = mock_response
    
    result = plan_task(query="Summarize this text", extracted_text="Some text content", file_type="txt")
    
    assert result["status"] == "ready"
    assert result["task_type"] == "summarize"
    assert len(result["plan"]) == 2
    assert result["plan"][0]["description"] == "Read source text"

def test_cost_estimator():
    """Verifies cost calculation heuristics."""
    # Character count = 40 (approx 10 tokens), audio = 0s
    cost_text_only = estimate_cost("Hello world of AI", "This is some test content.", "txt", "summarize")
    assert cost_text_only > 0.0
    
    # Image cost adds 258 tokens
    cost_image = estimate_cost("Explain this", "Code snippet here", "png", "code_explain")
    assert cost_image > cost_text_only
    
    # Audio duration adds tokens
    cost_audio = estimate_cost("Transcribe", "trans", "wav", "audio_transcribe_summary", audio_duration=120.0)
    assert cost_audio > cost_text_only

@patch("google.genai.Client")
def test_executor_summarize_routing(mock_client_class):
    """Verifies the executor triggers task execution correctly."""
    mock_client = MagicMock()
    mock_client_class.return_value = mock_client
    
    mock_response = MagicMock()
    mock_response.text = (
        "1-Line Summary:\nTest line\n\n"
        "3 Bullet Points:\n- Point 1\n- Point 2\n- Point 3\n\n"
        "5-Sentence Summary:\nSentence 1. Sentence 2. Sentence 3. Sentence 4. Sentence 5."
    )
    mock_client.models.generate_content.return_value = mock_response
    
    session = create_session()
    session.original_query = "Summarize this"
    session.extracted_text = "Detailed transcript about deep learning and model fine-tuning processes."
    session.task_type = "summarize"
    session.plan = [{"step": 1, "description": "Generate summary"}]
    
    res = execute_plan(session)
    
    assert "1-Line Summary:" in res
    assert "3 Bullet Points:" in res
    assert "Sentence 5." in res
    assert session.status == "completed"
    assert len(session.logs) > 0

def test_api_chat_validation():
    """Tests input validation on FastAPI endpoint."""
    response = client.post("/api/chat")
    assert response.status_code == 400
    assert "Either query or file upload" in response.json()["detail"]
