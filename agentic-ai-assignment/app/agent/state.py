import uuid
from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field

class SessionState(BaseModel):
    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    original_query: Optional[str] = None
    file_name: Optional[str] = None
    file_type: Optional[str] = None
    extracted_text: Optional[str] = None
    task_type: Optional[str] = None
    plan: List[Dict[str, Any]] = Field(default_factory=list)
    status: str = "created"  # created, ambiguous, ready, running, completed, failed
    follow_up_question: Optional[str] = None
    history: List[Dict[str, str]] = Field(default_factory=list)  # [{"role": "user", "content": "..."}, {"role": "agent", "content": "..."}]
    logs: List[str] = Field(default_factory=list)
    result: Optional[str] = None
    cost_estimate: float = 0.0

    def add_log(self, message: str):
        self.logs.append(message)

# In-memory database of sessions
_sessions: Dict[str, SessionState] = {}

def create_session() -> SessionState:
    session = SessionState()
    _sessions[session.session_id] = session
    return session

def get_session(session_id: str) -> Optional[SessionState]:
    return _sessions.get(session_id)

def update_session(session_id: str, **kwargs) -> Optional[SessionState]:
    session = get_session(session_id)
    if session:
        for key, value in kwargs.items():
            if hasattr(session, key):
                setattr(session, key, value)
        return session
    return None
