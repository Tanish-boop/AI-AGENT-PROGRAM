import logging
import tenacity
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception, before_sleep_log
from google.genai.errors import APIError

logger = logging.getLogger("app.agent.retry_helper")

def is_transient_gemini_error(exception: Exception) -> bool:
    """
    Returns True if the exception is a transient Gemini API error that should be retried.
    Transient errors include:
    - ServerError (status code 5xx, e.g. 503 Service Unavailable)
    - APIError with code 429 (ResourceExhausted / Rate Limit) or 5xx
    - Any general exception containing temporary/transient indicators (e.g. 503, UNAVAILABLE)
    """
    if isinstance(exception, APIError):
        code = getattr(exception, "code", None)
        message = getattr(exception, "message", None)
        logger.warning(
            f"Gemini APIError encountered: code={code}, message={message}. "
            f"Checking if transient for retry."
        )
        if code in [429, 500, 502, 503, 504]:
            return True
        
        # Check string representations in message/exception
        msg_str = str(message or exception).upper()
        if any(err in msg_str for err in ["503", "500", "429", "UNAVAILABLE", "RESOURCE_EXHAUSTED", "TEMPORARY"]):
            return True
            
    # Also capture other generic/network exceptions that mention 503 or UNAVAILABLE
    msg_str = str(exception).upper()
    if any(err in msg_str for err in ["503", "500", "429", "UNAVAILABLE", "RESOURCE_EXHAUSTED"]):
        logger.warning(f"Suspected transient error (non-APIError type: {type(exception).__name__}): {exception}")
        return True
        
    return False

# Retry decorator configuration:
# - Stop after 5 attempts
# - Exponential backoff starting at 2s, up to 10s max
# - Logs warning before sleeping between retries
gemini_retry_decorator = retry(
    retry=retry_if_exception(is_transient_gemini_error),
    stop=stop_after_attempt(5),
    wait=wait_exponential(multiplier=1, min=2, max=10),
    before_sleep=before_sleep_log(logger, logging.WARNING),
    reraise=True
)
