import copy
import json

import pytest
from pydantic import ValidationError

from app.services.geometry import EMPTY, validate
from tests.conftest import create_project, designer_with_studio, geometry


def bad(mutator):
    g = geometry()
    mutator(g)
    with pytest.raises(ValidationError):
        validate(g)


def test_valid_and_empty_plans():
    assert validate(geometry())["walls"][0]["structural"] is True
    assert validate(copy.deepcopy(EMPTY)) == EMPTY
    assert validate({}) == EMPTY


def test_zero_length_wall():
    bad(lambda g: g["walls"][0].update(b=[0, 0]))


def test_opening_wider_than_wall():
    bad(lambda g: g["openings"][0].update(width=4500))
    bad(lambda g: g["openings"][0].update(offset=3500, width=900))  # offset + width > 4000
    bad(lambda g: g["openings"][0].update(offset=-1))


def test_non_finite_and_huge_coordinates():
    for v in (float("nan"), float("inf"), float("-inf"), 1e9, -100001):
        bad(lambda g, v=v: g["walls"][0].update(a=[v, 0]))
        bad(lambda g, v=v: g["furniture"][0].update(x=v))


def test_polygon_and_strings_and_counts():
    bad(lambda g: g["rooms"][0].update(polygon=[[0, 0], [10, 10]]))
    bad(lambda g: g["rooms"][0].update(polygon=[[0, 0], [10, 10], [20, 20]]))  # zero area
    bad(lambda g: g["rooms"][0].update(name="x" * 10_000))
    bad(lambda g: g["furniture"][0].update(catalog_key="k" * 65))
    bad(lambda g: g["furniture"][0].update(id="bad id <script>"))
    bad(lambda g: g["walls"].extend({"id": f"x{i}", "a": [0, 0], "b": [1, 1]} for i in range(501)))
    bad(lambda g: g["furniture"][1].update(id="f1"))  # duplicate ids
    bad(lambda g: g["openings"][0].update(wall_id="nope"))
    bad(lambda g: g["walls"][0].update(unexpected=1))
    bad(lambda g: g["walls"][0].update(thickness=0))


def test_api_rejects_invalid_geometry_with_422():
    c, _ = designer_with_studio()
    p = create_project(c)
    url = f"/projects/{p['id']}/plan/versions"
    g = geometry()
    g["walls"][0]["b"] = [0, 0]
    r = c.post(url, json={"geometry": g})
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"
    raw = json.dumps({"geometry": geometry()}).replace('"x": 1000', '"x": NaN')
    r = c.post(url, content=raw, headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    g = geometry(room_name="x" * 10_000)
    assert c.post(url, json={"geometry": g}).status_code == 422
    assert c.post(url, json={"geometry": EMPTY}).status_code == 201
    assert c.post("/projects", json={"name": "x" * 10_000}).status_code == 422
