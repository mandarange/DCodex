#if canImport(XCTest)
import XCTest

final class ProcessClientTests: XCTestCase {
    func testNativeTimeoutAndEmptyOutputAreStablePublicErrors() {
        XCTAssertEqual(
            ProcessClient.nativeFailureOutput("native_process_timeout"),
            #"{"schema":"sks.native-process-error.v1","ok":false,"error":"native_process_timeout"}"#
        )
        XCTAssertEqual(
            ProcessClient.nativeFailureOutput("native_process_empty_output"),
            #"{"schema":"sks.native-process-error.v1","ok":false,"error":"native_process_empty_output"}"#
        )
    }
}
#endif
