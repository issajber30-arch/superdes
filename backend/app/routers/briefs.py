import uuid
from typing import Annotated, Literal

from fastapi import APIRouter
from psycopg.types.json import Jsonb
from pydantic import Field, model_validator

from ..deps import MemberCtx, get_project
from ..errors import ApiError
from ..schemas import Strict

router = APIRouter(tags=["briefs"])

Short = Annotated[str, Field(min_length=1, max_length=60)]
Line = Annotated[str, Field(min_length=1, max_length=300)]
Money = Annotated[float, Field(ge=0, le=100_000_000, allow_inf_nan=False)]


class Budget(Strict):
    min: Money | None = None
    max: Money | None = None
    currency: Annotated[str, Field(pattern=r"^[A-Z]{3}$")] = "EUR"
    priority: Literal["low_cost", "balanced", "premium"] = "balanced"

    @model_validator(mode="after")
    def _order(self):
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ValueError("budget.min must be <= budget.max")
        return self


class Household(Strict):
    adults: Annotated[int, Field(ge=0, le=20)] = 1
    children: Annotated[int, Field(ge=0, le=20)] = 0
    pets: list[Short] = Field(default_factory=list, max_length=10)
    works_from_home: bool = False
    accessibility_needs: Annotated[str, Field(max_length=1000)] = ""


class ExistingItem(Strict):
    name: Annotated[str, Field(min_length=1, max_length=100)]
    keep: bool = True
    width_mm: Annotated[int, Field(gt=0, le=20000)] | None = None
    depth_mm: Annotated[int, Field(gt=0, le=20000)] | None = None
    notes: Annotated[str, Field(max_length=500)] = ""


class Brief(Strict):
    styles: list[Short] = Field(default_factory=list, max_length=10)
    colors: list[Short] = Field(default_factory=list, max_length=20)
    materials: list[Short] = Field(default_factory=list, max_length=20)
    budget: Budget = Field(default_factory=Budget)
    functional_needs: list[Line] = Field(default_factory=list, max_length=30)
    household: Household = Field(default_factory=Household)
    lifestyle: list[Line] = Field(default_factory=list, max_length=20)
    constraints: list[Line] = Field(default_factory=list, max_length=30)
    inspiration_upload_ids: list[uuid.UUID] = Field(default_factory=list, max_length=30)
    inspiration_urls: list[Annotated[str, Field(max_length=500, pattern=r"^https?://\S+$")]] = Field(default_factory=list, max_length=20)
    existing_items: list[ExistingItem] = Field(default_factory=list, max_length=50)
    notes: Annotated[str, Field(max_length=5000)] = ""


def load_brief(conn, project_id) -> dict:
    row = conn.execute("select data from briefs where project_id = %s", (project_id,)).fetchone()
    return Brief.model_validate(row["data"] if row else {}).model_dump(mode="json")


@router.get("/projects/{project_id}/brief")
def get_brief(project_id: uuid.UUID, ctx: MemberCtx):
    get_project(ctx, project_id)
    row = ctx.conn.execute("select updated_at, updated_by from briefs where project_id = %s", (project_id,)).fetchone()
    return {"brief": load_brief(ctx.conn, project_id), **(row or {})}


@router.put("/projects/{project_id}/brief")
def put_brief(project_id: uuid.UUID, body: Brief, ctx: MemberCtx):
    get_project(ctx, project_id)
    if body.inspiration_upload_ids:
        n = ctx.conn.execute("select count(*) as n from uploads where project_id = %s and id = any(%s)",
                             (project_id, body.inspiration_upload_ids)).fetchone()["n"]
        if n != len(set(body.inspiration_upload_ids)):
            raise ApiError(422, "validation_error", "inspiration_upload_ids must reference this project's uploads")
    data = body.model_dump(mode="json")
    row = ctx.conn.execute(
        "insert into briefs (studio_id, project_id, data, updated_by) values (%s,%s,%s,%s) "
        "on conflict (project_id) do update set data = excluded.data, updated_by = excluded.updated_by, updated_at = now() "
        "returning updated_at, updated_by", (ctx.studio_id, project_id, Jsonb(data), ctx.user_id)).fetchone()
    return {"brief": data, **row}
