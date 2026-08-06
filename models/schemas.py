from dataclasses import dataclass
from typing import Literal

Role = Literal["master", "editor", "operator"]
AccountStatus = Literal["pending", "approved", "rejected", "disabled"]


@dataclass(frozen=True)
class UserProfile:
    id: str
    email: str
    display_name: str
    role: Role
    status: AccountStatus

    @classmethod
    def from_record(cls, data: dict) -> "UserProfile":
        return cls(
            id=str(data["id"]),
            email=str(data.get("email", "")),
            display_name=str(data.get("display_name", "")),
            role=data.get("role", "operator"),
            status=data.get("status", "pending"),
        )

    @property
    def approved(self) -> bool:
        return self.status == "approved"

    @property
    def can_edit(self) -> bool:
        return self.approved and self.role in ("master", "editor")

    @property
    def is_master(self) -> bool:
        return self.approved and self.role == "master"
