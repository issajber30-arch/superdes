from fastapi import HTTPException


class ApiError(HTTPException):
    def __init__(self, status: int, code: str, message: str, details=None):
        super().__init__(status_code=status, detail=message)
        self.code = code
        self.details = details


def not_found(what: str = "resource") -> ApiError:
    return ApiError(404, "not_found", f"{what} not found")


def forbidden(msg: str = "not allowed for your role") -> ApiError:
    return ApiError(403, "forbidden", msg)


def preview_closed() -> ApiError:
    return ApiError(403, "preview_mode", "not available in personal preview mode")


def error_json(status: int, code: str, message: str, details=None):
    """Return (not raise) an error so the request transaction still commits, e.g. failure audit rows."""
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message, "details": details}})
