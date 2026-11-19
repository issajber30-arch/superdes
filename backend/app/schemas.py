from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

Email = Annotated[str, Field(min_length=3, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")]
Password = Annotated[str, Field(min_length=8, max_length=128)]
Name = Annotated[str, Field(min_length=1, max_length=100)]
Text = Annotated[str, Field(max_length=5000)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Credentials(Strict):
    email: Email
    password: Password


class Register(Credentials):
    display_name: Annotated[str, Field(max_length=100)] = ""
