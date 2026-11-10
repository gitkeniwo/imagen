"""Pydantic request/response models."""
from typing import Literal, Optional

from pydantic import BaseModel, Field


class GenerateRequest(BaseModel):
    prompt: str = ""
    provider: str = "vertex"  # "vertex" | "gemini"
    model: str
    aspectRatio: Optional[str] = None
    resolution: Optional[str] = None  # "1K" | "2K" | "4K"
    outputFormat: str = "image/jpeg"  # "image/jpeg" | "image/png"
    inputImageIds: list[int] = Field(default_factory=list)
    uploadImageIds: list[int] = Field(default_factory=list)
    # Tags to auto-archive this task into (applied to output + inputs).
    tagIds: list[int] = Field(default_factory=list)
    # Client-side queue task id, used to publish live progress (see PROGRESS).
    clientTaskId: Optional[str] = None
    markerColor: Optional[str] = None
    # Series (leaf) this attempt belongs to; a theme or unknown id is a 4xx.
    seriesId: Optional[int] = None


class ManualGenerationRequest(BaseModel):
    """A generation row created/edited from results produced elsewhere (no provider call)."""
    prompt: str = ""
    provider: str = "vertex"
    model: str
    aspectRatio: Optional[str] = None
    resolution: Optional[str] = None
    status: str = "success"  # "success" | "blocked" | "error"
    source: str = "manual"   # "vertex" | "manual"
    errorMessage: Optional[str] = None
    inputImageIds: list[int] = Field(default_factory=list)
    outputImageId: Optional[int] = None
    tagIds: list[int] = Field(default_factory=list)
    createdAt: Optional[str] = None  # ISO-8601; defaults to now if omitted
    # Omitted on PATCH = keep the stored series; explicit null = no series.
    seriesId: Optional[int] = None


class DraftCreate(BaseModel):
    prompt: str = ""
    provider: str = "vertex"
    model: str = "gemini-3-pro-image"
    aspectRatio: Optional[str] = None
    resolution: Optional[str] = None
    outputFormat: Literal["image/jpeg", "image/png"] = "image/jpeg"
    skipIfPrecedingSucceeds: bool = False
    pinned: bool = False
    inputImageIds: list[int] = Field(default_factory=list)
    outputImageIds: list[int] = Field(default_factory=list)
    tagIds: list[int] = Field(default_factory=list)
    seriesId: Optional[int] = None


class DraftUpdate(BaseModel):
    prompt: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    aspectRatio: Optional[str] = None
    resolution: Optional[str] = None
    outputFormat: Optional[Literal["image/jpeg", "image/png"]] = None
    skipIfPrecedingSucceeds: Optional[bool] = None
    pinned: Optional[bool] = None
    inputImageIds: Optional[list[int]] = None
    outputImageIds: Optional[list[int]] = None
    tagIds: Optional[list[int]] = None
    seriesId: Optional[int] = None  # explicit null clears it


class MarkerPatch(BaseModel):
    markerColor: Optional[str] = None


class TagCreate(BaseModel):
    name: str
    color: Optional[str] = None


class TagUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    coverImageId: Optional[int] = None


class BatchTag(BaseModel):
    """Add or remove a set of tags on a set of images."""
    imageIds: list[int] = Field(default_factory=list)
    tagIds: list[int] = Field(default_factory=list)
    op: str = "add"  # "add" | "remove"


class SeriesCreate(BaseModel):
    kind: Literal["theme", "series"] = "series"
    name: str
    parentId: Optional[int] = None  # series only: the theme it sits under
    color: Optional[str] = None


class SeriesUpdate(BaseModel):
    """Partial update; a field that is present but null clears it (parentId →
    "No theme", coverImageId → automatic cover)."""
    name: Optional[str] = None
    color: Optional[str] = None
    parentId: Optional[int] = None
    archived: Optional[bool] = None
    coverImageId: Optional[int] = None
    # Deprecated alias, accepted for one release (series-v2 B5).
    bestImageId: Optional[int] = None


class SeriesMarkUpdate(BaseModel):
    """Set or replace one series-scoped mark; null clears it."""
    kind: Optional[Literal["pick", "reject"]]


class SeriesMarkClear(BaseModel):
    """Clear every pick in a series. Reject marks and the cover are untouched."""
    kind: Literal["pick"] = "pick"


class SeriesAssign(BaseModel):
    """Records to put into (or take out of) a series. Library images map to
    the generations that produced them."""
    generationIds: list[int] = Field(default_factory=list)
    draftIds: list[int] = Field(default_factory=list)
    imageIds: list[int] = Field(default_factory=list)


class SeriesReorder(BaseModel):
    """Move these records, as one block in their current relative order,
    right before or right after a target record of the same series."""
    generationIds: list[int]
    before: Optional[int] = None
    after: Optional[int] = None


class SeriesRestore(BaseModel):
    """A complete order to write back (undo of "reset to time order")."""
    generationIds: list[int]


class SeriesImport(BaseModel):
    tagId: int
    name: str
    parentId: Optional[int] = None
    color: Optional[str] = None
    # Also pull blocked/failed attempts whose prompt equals a tagged one.
    includeFailed: bool = False


class VertexConfig(BaseModel):
    project: str
    location: Optional[str] = None  # defaults to "global" on the server


class ProviderToggle(BaseModel):
    enabled: bool


class GeminiKeyBody(BaseModel):
    key: str


class ImagePatch(BaseModel):
    starred: Optional[bool] = None
    filename: Optional[str] = None
    note: Optional[str] = None
    source: Optional[str] = None  # "upload" | "generated"
