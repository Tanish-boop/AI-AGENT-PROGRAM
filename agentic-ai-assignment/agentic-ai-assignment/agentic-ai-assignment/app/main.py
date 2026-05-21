import os
import shutil
import logging
from typing import Optional
from fastapi import FastAPI, File, UploadFile, Form, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from app.agent.state import create_session, get_session, update_session
from app.agent.extractor import extract_from_file
from app.agent.planner import plan_task, estimate_cost
from app.agent.executor import execute_plan

load_dotenv()

# Setup logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("main")

app = FastAPI(title="Multimodal Agentic Content Processing App")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

TEMP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "temp_uploads")
os.makedirs(TEMP_DIR, exist_ok=True)

@app.post("/api/chat")
async def chat_endpoint(
    background_tasks: BackgroundTasks,
    query: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None)
):
    """
    Creates a new session, processes file uploads, plans the task, and runs it if ready.
    """
    if not query and not file:
        raise HTTPException(status_code=400, detail="Either query or file upload must be provided.")
        
    session = create_session()
    session_id = session.session_id
    
    session.add_log(f"[Backend] Created session: {session_id}")
    update_session(session_id, original_query=query)
    
    extracted_text = None
    file_name = None
    file_type = None
    temp_file_path = None
    
    # 1. Handle file upload and extraction
    if file:
        file_name = file.filename
        file_type = file.filename.split(".")[-1]
        temp_file_path = os.path.join(TEMP_DIR, f"{session_id}_{file_name}")
        
        session.add_log(f"[Backend] Saving uploaded file: {file_name}")
        with open(temp_file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        session.add_log(f"[Backend] Extracting text content from {file_name}...")
        try:
            extraction = extract_from_file(temp_file_path, file_type)
            extracted_text = extraction.get("text", "")
            confidence = extraction.get("confidence", 1.0)
            method = extraction.get("method", "standard")
            
            session.add_log(f"[Backend] Extraction complete. Method: {method}, Confidence: {confidence*100:.1f}%")
            
            update_session(
                session_id,
                file_name=file_name,
                file_type=file_type,
                extracted_text=extracted_text,
                temp_file_path=temp_file_path  # Saved for audio processing or execution task references
            )
        except Exception as e:
            session.add_log(f"[Backend] [ERROR] Extraction failed: {str(e)}")
            # Cleanup temp file on immediate failure
            if os.path.exists(temp_file_path):
                os.remove(temp_file_path)
            raise HTTPException(status_code=500, detail=f"File parsing error: {str(e)}")

    # 2. Plan the task based on inputs
    session.add_log("[Backend] Invoking Planner to understand user intent...")
    try:
        planning = plan_task(
            query=query or "",
            extracted_text=extracted_text,
            file_type=file_type
        )
        
        update_session(
            session_id,
            status=planning["status"],
            follow_up_question=planning["follow_up_question"],
            task_type=planning["task_type"],
            plan=planning["plan"],
            cost_estimate=planning["cost_estimate"]
        )
        
        session.add_log(f"[Backend] Planner Reasoning: {planning['reasoning']}")
        if planning["status"] == "ambiguous":
            session.add_log(f"[Backend] Ambiguous intent detected. Asking: '{planning['follow_up_question']}'")
            
    except Exception as e:
        session.add_log(f"[Backend] [ERROR] Planning failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Planning error: {str(e)}")

    # 3. Execute plan if ready
    if session.status == "ready":
        background_tasks.add_task(execute_plan, session)
        
    return session

@app.post("/api/respond")
async def respond_endpoint(
    background_tasks: BackgroundTasks,
    session_id: str = Form(...),
    clarification: str = Form(...)
):
    """
    Submits user's response to follow-up questions, updates plan, and executes it.
    """
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")
        
    session.add_log(f"[Backend] Received user clarification: '{clarification}'")
    
    # Store history
    session.history.append({"role": "user", "content": clarification})
    
    # Re-plan by combining original query with clarification
    combined_query = f"{session.original_query or ''} [Clarification: {clarification}]".strip()
    session.add_log("[Backend] Re-invoking Planner with clarification context...")
    
    try:
        planning = plan_task(
            query=combined_query,
            extracted_text=session.extracted_text,
            file_type=session.file_type
        )
        
        update_session(
            session_id,
            status=planning["status"],
            follow_up_question=planning["follow_up_question"],
            task_type=planning["task_type"],
            plan=planning["plan"],
            cost_estimate=planning["cost_estimate"]
        )
        
        session.add_log(f"[Backend] Planner Reasoning: {planning['reasoning']}")
        
    except Exception as e:
        session.add_log(f"[Backend] [ERROR] Planning failed: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Planning error: {str(e)}")

    # Execute plan if ready
    if session.status == "ready":
        background_tasks.add_task(execute_plan, session)
        
    return session

@app.get("/api/status/{session_id}")
async def status_endpoint(session_id: str):
    """
    Checks on background execution status, logs, and output results.
    """
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")
    return session

@app.post("/api/cost")
async def cost_endpoint(
    query: Optional[str] = Form(""),
    extracted_text: Optional[str] = Form(""),
    file_type: Optional[str] = Form(""),
    task_type: Optional[str] = Form("")
):
    """
    Independent endpoint to retrieve a quick cost estimate for a workflow configuration.
    """
    cost = estimate_cost(
        query=query,
        extracted_text=extracted_text,
        file_type=file_type,
        task_type=task_type
    )
    return {"estimated_cost_usd": cost}

# Serves Static Frontend files
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
if os.path.exists(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
else:
    @app.get("/")
    def read_root():
        return {"message": "Welcome. The static directory is missing. Please build the frontend."}
