package sv.mh.fe.filter;

public class FirmarDocumentoFilter {
	private String passwordPub;
	private String passwordPri;
	private String nit;
	private String nombreDocumento;
	private String nombreFirma;
	private String compactSerialization;
	private Object dteJson;
	private String dte;
	private boolean activo;

	public FirmarDocumentoFilter() {
	}

	public String getPasswordPub() {
		return this.passwordPub;
	}

	public void setPasswordPub(String passwordPub) {
		this.passwordPub = passwordPub;
	}

	public String getPasswordPri() {
		return this.passwordPri;
	}

	public void setPasswordPri(String passwordPri) {
		this.passwordPri = passwordPri;
	}

	public String getNit() {
		return this.nit;
	}

	public void setNit(String nit) {
		this.nit = nit;
	}

	public boolean getActivo() {
		return this.activo;
	}

	public void setActivo(boolean activo) {
		this.activo = activo;
	}

	public String getNombreDocumento() {
		return this.nombreDocumento;
	}

	public void setNombreDocumento(String nombreDocumento) {
		this.nombreDocumento = nombreDocumento;
	}

	public String getNombreFirma() {
		return this.nombreFirma;
	}

	public void setNombreFirma(String nombreFirma) {
		this.nombreFirma = nombreFirma;
	}

	public String getCompactSerialization() {
		return this.compactSerialization;
	}

	public void setCompactSerialization(String compactSerialization) {
		this.compactSerialization = compactSerialization;
	}

	public Object getDteJson() {
		return this.dteJson;
	}

	public void setDteJson(Object dteJson) {
		this.dteJson = dteJson;
	}

	public String getDte() {
		return this.dte;
	}

	public void setDte(String dte) {
		this.dte = dte;
	}
}
