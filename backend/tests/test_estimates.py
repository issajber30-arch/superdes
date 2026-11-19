from tests.conftest import create_project, designer_with_studio


def test_estimates_non_binding_and_overrides():
    c, _ = designer_with_studio()
    pid = create_project(c)["id"]
    assert c.put(f"/projects/{pid}/finishes", json={"room_id": "r1", "surface": "floor", "finish_key": "oak-parquet"}).status_code == 200
    assert c.put(f"/projects/{pid}/finishes", json={"room_id": "r1", "surface": "floor", "finish_key": "paint-white"}).status_code == 422
    e = c.get(f"/projects/{pid}/estimates").json()
    assert e["non_binding"] is True and e["basis"] == "generic estimate, not a retailer price" and "non-binding" in e["label"]
    items = {i["item_key"]: i for i in e["items"]}
    assert items["furn:sofa-3"]["unit_low"] == 600 and items["furn:sofa-3"]["qty"] == 1
    assert items["finish:r1:floor"]["qty"] == 20.0  # 5m x 4m
    assert e["totals"]["low"] == 600 + 80 + 20 * 40

    e = c.put(f"/projects/{pid}/estimates/overrides/furn:sofa-3", json={"unit_low": 1000, "unit_high": 1200}).json()
    assert next(i for i in e["items"] if i["item_key"] == "furn:sofa-3")["overridden"]
    e = c.put(f"/projects/{pid}/estimates/overrides/furn:coffee-table", json={"excluded": True}).json()
    e = c.post(f"/projects/{pid}/estimates/items", json={"label": "Curtains", "qty": 2, "unit_low": 50, "unit_high": 90}).json()
    assert e["totals"]["low"] == 1000 + 800 + 100
    assert c.put(f"/projects/{pid}/estimates/overrides/furn:sofa-3", json={"unit_low": 10, "unit_high": 5}).status_code == 422
    assert c.put(f"/projects/{pid}/estimates/overrides/bad-key", json={}).status_code == 422

    sl = c.get(f"/projects/{pid}/shopping-list").json()
    assert sl["non_binding"] is True and sl["basis"] == "generic estimate, not a retailer price"
    assert "furn:coffee-table" not in {i["item_key"] for i in sl["items"]}


def test_catalog_is_seeded_and_public():
    c = __import__("tests.conftest", fromlist=["new_client"]).new_client()
    f = c.get("/catalog/furniture").json()["items"]
    assert len(f) >= 30 and {"toilet", "kitchen-sink", "shower"} <= {i["key"] for i in f}
    assert len(c.get("/catalog/finishes").json()["finishes"]) >= 15
    assert len(c.get("/catalog/styles").json()["styles"]) >= 8
    assert all(i["room_kinds"] == ["bathroom"] for i in c.get("/catalog/furniture", params={"category": "bathroom"}).json()["items"])
